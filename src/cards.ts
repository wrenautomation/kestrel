/**
 * The ICM cards' side of the map: the why, trade-offs and extension points. Kestrel reads only
 * their frontmatter: `type`, `entity` (a path that must exist), `covers` (generated node ids),
 * and `stamp` (the hash of those nodes when someone last read the card against them).
 */
import { createHash } from "node:crypto";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { type Graph, type Node, normalize } from "./graph.js";

export interface Card {
  /** Relative to the repo root. */
  path: string;
  /** `object`, `process`, `pattern`, `decision`, `requirement`. */
  type?: string;
  /** `path:line` of the owning file; it gives the card its default coverage. */
  entity?: string;
  covers: string[];
  stamp?: string;
  /** The first paragraph under a `## Why…` heading, else the first after the title. */
  why: string;
}

export type CardIssue =
  | { rule: "coverage"; node: string }
  | { rule: "entity"; card: string; entity: string }
  | { rule: "stale"; card: string };

/** Folders under the cards dir that hold no cards. */
const SKIP = new Set(["generated", "_templates", "_meta", "node_modules"]);
const FRONT = /^---\n([\s\S]*?)\n---\n?/;

export async function readCards(root: string, dir: string): Promise<Card[]> {
  const out: Card[] = [];
  const walk = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await walk(p);
      } else if (e.name.endsWith(".md")) {
        const card = parseCard(relative(root, p), await readFile(p, "utf8"));
        if (card) out.push(card);
      }
    }
  };
  await walk(resolve(root, dir));
  return out;
}

/** A card is a Markdown file with frontmatter; other Markdown (an index, a README) is not. */
export function parseCard(path: string, text: string): Card | null {
  const m = FRONT.exec(text);
  if (!m) return null;
  const f = frontOf(m[1] ?? "");
  const str = (v: unknown) =>
    typeof v === "string" || typeof v === "number" ? String(v) : undefined;
  const covers = Array.isArray(f.covers) ? f.covers.map(String) : [];
  const type = str(f.type);
  const entity = str(f.entity);
  const stamp = str(f.stamp);
  return {
    path,
    ...(type ? { type } : {}),
    ...(entity ? { entity } : {}),
    covers,
    ...(stamp ? { stamp } : {}),
    why: whyOf(text.slice(m[0].length)),
  };
}

/**
 * YAML, else one `key: value` per line: ICM frontmatter is often loose (`verified: 2026-10-20
 * (O2: post)` is not YAML), and its own tools read it line by line.
 */
function frontOf(text: string): Record<string, unknown> {
  try {
    const f: unknown = parse(text);
    if (f && typeof f === "object" && !Array.isArray(f)) return f as Record<string, unknown>;
  } catch {}
  const out: Record<string, unknown> = {};
  for (const l of text.split("\n")) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(l);
    if (kv?.[1]) out[kv[1]] = kv[2]?.startsWith("[") ? lenientList(kv[2]) : kv[2];
  }
  return out;
}

const lenientList = (v: string): string[] =>
  v
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((x) => x.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);

function whyOf(body: string): string {
  const paras = (s: string) =>
    s
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p && !p.startsWith("#"));
  const why = /^## Why[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body);
  const first = why ? paras(why[1] ?? "")[0] : undefined;
  return first ?? paras(body)[0] ?? "";
}

/** Everything the cards are checked against: approved nodes by id, and each file's exports. */
export interface CardIndex {
  nodes: Map<string, Node>;
  /** Repo-relative path → file node id, from each package's `dir`. */
  fileAt(path: string): string | undefined;
  /** File node id → its export node ids. */
  exportsOf: Map<string, string[]>;
}

export function indexOf(graphs: readonly Graph[]): CardIndex {
  const nodes = new Map<string, Node>();
  for (const g of graphs) for (const n of g.nodes) nodes.set(n.id, n);
  const pkgs = [...nodes.values()]
    .filter((n) => n.role === "package" && typeof n.attrs?.dir === "string")
    .map((n) => ({ id: n.id, dir: String(n.attrs?.dir) }))
    .sort((a, b) => b.dir.length - a.dir.length);
  const fileAt = (path: string) => {
    const p = pkgs.find((x) => path.startsWith(x.dir));
    const id = p && `${p.id}/${path.slice(p.dir.length)}`;
    return id && nodes.has(id) ? id : undefined;
  };
  const exportsOf = new Map<string, string[]>();
  for (const n of nodes.values()) {
    if (n.role !== "export" || typeof n.attrs?.file !== "string") continue;
    const f = fileAt(n.attrs.file);
    if (f) exportsOf.set(f, [...(exportsOf.get(f) ?? []), n.id]);
  }
  return { nodes, fileAt, exportsOf };
}

const entityPath = (entity: string) => entity.replace(/:\d+(-\d+)?$/, "");

/**
 * The nodes a card covers: its `covers`, plus the file its `entity` names. A file brings its
 * exports, so a changed signature makes the card stale; a changed import does not.
 */
export function coveredBy(card: Card, ix: CardIndex): string[] {
  const out = new Set<string>();
  const add = (id: string) => {
    out.add(id);
    for (const e of ix.exportsOf.get(id) ?? []) out.add(e);
  };
  for (const id of card.covers) add(id);
  const f = card.entity && ix.fileAt(entityPath(card.entity));
  if (f) add(f);
  return [...out].sort();
}

/** Hash of the approved nodes a card covers. An id with no node counts, so a removal shows. */
export function stampOf(card: Card, ix: CardIndex): string {
  const g = normalize({
    layer: "cards",
    nodes: coveredBy(card, ix).map((id) => ix.nodes.get(id) ?? { id, role: "file", group: "-" }),
    edges: [],
  });
  return createHash("sha256").update(JSON.stringify(g.nodes)).digest("hex").slice(0, 8);
}

/**
 * coverage: a node of a required role with no card on it or on a node under it.
 * entity: a card whose entity path is gone.
 * stale: a card with a stamp that no longer matches its covered nodes. A card never stamped is
 * not stale: it was never read against the map.
 */
export async function checkCards(
  root: string,
  cards: readonly Card[],
  ix: CardIndex,
  require: readonly string[],
): Promise<CardIssue[]> {
  const issues: CardIssue[] = [];
  const held = new Set<string>();
  for (const c of cards) {
    if (c.entity) {
      const p = entityPath(c.entity);
      const ok = await access(resolve(root, p)).then(
        () => true,
        () => false,
      );
      if (!ok) issues.push({ rule: "entity", card: c.path, entity: p });
    }
    if (c.stamp && c.stamp !== stampOf(c, ix)) issues.push({ rule: "stale", card: c.path });
    for (const id of coveredBy(c, ix))
      for (let n = ix.nodes.get(id); n; n = n.parent ? ix.nodes.get(n.parent) : undefined) {
        if (held.has(n.id)) break;
        held.add(n.id);
      }
  }
  for (const n of ix.nodes.values())
    if (require.includes(n.role) && !held.has(n.id)) issues.push({ rule: "coverage", node: n.id });
  return issues;
}

export function formatIssues(issues: readonly CardIssue[]): string {
  return issues
    .map((i) =>
      i.rule === "coverage"
        ? `  no card   ${i.node}`
        : i.rule === "entity"
          ? `  gone      ${i.card}: entity ${i.entity}`
          : `  stale     ${i.card}`,
    )
    .join("\n");
}

/** Writes the current stamp into a card's frontmatter, after a person read it. Only that line changes. */
export async function restamp(root: string, card: Card, ix: CardIndex): Promise<void> {
  const file = resolve(root, card.path);
  const text = await readFile(file, "utf8");
  const m = FRONT.exec(text);
  if (!m) throw new Error(`${card.path}: no frontmatter`);
  const line = `stamp: ${stampOf(card, ix)}`;
  const front = m[1] ?? "";
  const next = /^stamp:.*$/m.test(front) ? front.replace(/^stamp:.*$/m, line) : `${front}\n${line}`;
  await writeFile(file, `---\n${next}\n---\n${text.slice(m[0].length)}`);
}
