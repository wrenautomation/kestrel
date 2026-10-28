/**
 * The packet: what the last `gen` changes against the approved map, as one page to read before
 * `kestrel approve`. It is the "what" half of a design packet; the design doc holds the why.
 * Import edges lift to packages: a new package that uses another is the design fact, a new file
 * edge inside one is not. A changed node shows only what moved, a signature before and after.
 */
import { type Card, type CardIndex, coveredBy, stampOf } from "./cards.js";
import { type Measures, measure } from "./cost.js";
import { type Change, diff } from "./diff.js";
import type { Attrs, Graph } from "./graph.js";

export interface PacketLayer {
  id: string;
  approved: Graph | null;
  current: Graph | null;
}

export interface PacketInput {
  layers: PacketLayer[];
  cards: readonly Card[];
  was: CardIndex;
  now: CardIndex;
  measures: Measures;
}

const tick = (s: unknown) => `\`${String(s)}\``;

/** The few facts that say what a node is, for an added or removed line. */
function brief(a: Attrs | undefined): string {
  if (!a) return "";
  const at = (k: string) => a[`attrs.${k}`];
  const sig = at("sig");
  if (sig !== undefined) return `: ${tick(sig)}`;
  if (at("input") !== undefined) return `: ${tick(at("input"))} → ${tick(at("output"))}`;
  const cols = at("columns");
  if (Array.isArray(cols)) return `: ${cols.length} columns`;
  const label = at("label") ?? at("name") ?? at("title");
  return label !== undefined ? `: ${label}` : "";
}

/** What moved in a changed node: list keys as added and removed items, the rest before → after. */
function moved(before: Attrs, after: Attrs): string[] {
  const out: string[] = [];
  for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = before[k];
    const b = after[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const key = k.replace(/^attrs\./, "");
    if (Array.isArray(a) || Array.isArray(b)) {
      const was = new Set((a as readonly unknown[] | undefined)?.map(String) ?? []);
      const now = new Set((b as readonly unknown[] | undefined)?.map(String) ?? []);
      for (const x of now) if (!was.has(x)) out.push(`${key} + ${tick(x)}`);
      for (const x of was) if (!now.has(x)) out.push(`${key} − ${tick(x)}`);
    } else if (a === undefined) out.push(`${key}: ${tick(b)}`);
    else if (b === undefined) out.push(`${key}: no longer set (was ${tick(a)})`);
    else out.push(`${key}: ${tick(a)} → ${tick(b)}`);
  }
  return out;
}

/** Package → package uses, from file → file import edges. */
function uses(g: Graph | null): Map<string, number> {
  const pkg = new Map<string, string>();
  for (const n of g?.nodes ?? []) if (n.role === "file" && n.parent) pkg.set(n.id, n.parent);
  const out = new Map<string, number>();
  for (const e of g?.edges ?? []) {
    const a = pkg.get(e.from);
    const b = pkg.get(e.to) ?? (g?.nodes.some((n) => n.id === e.to) ? e.to : undefined);
    if (!a || !b || a === b) continue;
    const k = `${a}\0${b}`;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

export function packet(p: PacketInput): string {
  const L: string[] = [
    "# Map changes since approve",
    "",
    "From the last `kestrel gen`. Read it with the design doc. If it is right: `kestrel approve`, then commit.",
    "",
    "| Layer | Added | Removed | Changed |",
    "|---|---|---|---|",
  ];
  const body: string[] = [];
  const changedIds = new Set<string>();
  for (const l of p.layers) {
    if (!l.current) continue;
    const changes = diff(l.approved ?? { layer: l.id, nodes: [], edges: [] }, l.current);
    const nodes = changes.filter((c) => c.what === "node");
    for (const c of nodes) changedIds.add(c.id);
    const count = (op: Change["op"]) => changes.filter((c) => c.op === op).length;
    L.push(`| ${l.id} | ${count("add")} | ${count("remove")} | ${count("change")} |`);
    if (!changes.length) continue;
    body.push("", `## ${l.id}`);
    if (!l.approved) body.push("", "Nothing approved yet: every node is new.");
    const list = (title: string, items: string[]) => {
      if (items.length) body.push("", `### ${title}`, "", ...items);
    };
    const plain = (op: "add" | "remove") =>
      nodes.flatMap((c) => (c.op === op ? [`- ${tick(c.id)}${brief(c.attrs)}`] : []));
    list("Added", plain("add"));
    list("Removed", plain("remove"));
    list(
      "Changed",
      nodes.flatMap((c) =>
        c.op === "change"
          ? [`- ${tick(c.id)}`, ...moved(c.before, c.after).map((m) => `  - ${m}`)]
          : [],
      ),
    );
    if (l.id === "imports") {
      const was = uses(l.approved);
      const now = uses(l.current);
      const pair = (k: string) => k.split("\0").map(tick).join(" uses ");
      list(
        "New package uses",
        [...now].filter(([k]) => !was.has(k)).map(([k, n]) => `- ${pair(k)} (${n} imports)`),
      );
      list(
        "Gone package uses",
        [...was].filter(([k]) => !now.has(k)).map(([k]) => `- ${pair(k)}`),
      );
      const edges = changes.filter((c) => c.what === "edge");
      if (edges.length)
        body.push(
          "",
          `File imports: ${edges.filter((c) => c.op === "add").length} added, ${edges.filter((c) => c.op === "remove").length} removed.`,
        );
    } else {
      const edges = changes.filter((c) => c.what === "edge" && c.op !== "change");
      list(
        "Lines",
        edges.map((c) => `- ${c.op === "add" ? "+" : "−"} ${tick(c.id)}`),
      );
    }
  }
  const reread = p.cards.filter(
    (c) =>
      (c.stamp && stampOf(c, p.now) !== stampOf(c, p.was)) ||
      coveredBy(c, p.now).some((id) => changedIds.has(id)),
  );
  if (reread.length) {
    body.push(
      "",
      "## Cards to read again",
      "",
      "Each covers a node that changed. Read it, fix it, then `kestrel stamp` it.",
      "",
    );
    for (const c of reread) body.push(`- ${tick(c.path)}${c.why ? `: ${c.why}` : ""}`);
  }
  const over = p.cards.flatMap((c) => {
    const t = c.trigger;
    if (!t || "error" in t) return [];
    const n = measure(t, p.measures);
    return n !== null && n > t.over
      ? [
          `- ${tick(c.path)}: ${t.metric}${t.node ? ` ${t.node}` : ""} is ${Math.round(n * 100) / 100}, over ${t.over}`,
        ]
      : [];
  });
  if (over.length)
    body.push("", "## Decisions due again", "", "Their trigger is over its line.", "", ...over);
  return `${[...L, ...body].join("\n")}\n`;
}
