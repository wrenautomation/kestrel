/**
 * Repos, services and the seams between them, from a LikeC4 model. The only hand-written layer,
 * so `seams` checks it: a relation names a code path on each end (`here` at the source, `there`
 * at the target; `from` is a LikeC4 keyword), and an
 * element may name its own (`code`); every path must exist.
 * Nodes: `system` (a top-level element), `part` (one inside it; not `service`, which is a
 * Restate service in the routes layer); ids `system:<likec4 id>`.
 * Edges: `calls` (or the relation's own kind), attrs: titles and the two code paths. Two
 * relations between the same pair are one edge. Groups: one per top-level element.
 */
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { Attr, Edge, Graph, Node } from "../graph.js";
import type { Layer, LayerContext } from "./layer.js";

/** What the layer reads from LikeC4's computed model, plain so a test can give it. */
export interface C4 {
  elements: {
    id: string;
    kind: string;
    title: string;
    parent?: string | undefined;
    description?: string | undefined;
    technology?: string | undefined;
    metadata?: Record<string, string | string[]> | undefined;
  }[];
  relations: {
    from: string;
    to: string;
    kind?: string | undefined;
    title?: string | undefined;
    metadata?: Record<string, string | string[]> | undefined;
  }[];
}

const nodeId = (id: string) => `system:${id}`;
const list = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

export function fromC4(m: C4): Graph {
  const nodes: Node[] = m.elements.map((e) => {
    const attrs: Record<string, Attr> = { kind: e.kind, title: e.title };
    if (e.description) attrs.description = e.description;
    if (e.technology) attrs.technology = e.technology;
    const code = list(e.metadata?.code);
    if (code.length) attrs.code = code;
    return {
      id: nodeId(e.id),
      role: e.parent ? "part" : "system",
      ...(e.parent ? { parent: nodeId(e.parent) } : {}),
      group: e.id.split(".")[0] ?? e.id,
      attrs,
    };
  });
  const pairs = new Map<
    string,
    Edge & { attrs: { title: string[]; here: string[]; there: string[] } }
  >();
  for (const r of m.relations) {
    const from = nodeId(r.from);
    const to = nodeId(r.to);
    const kind = r.kind ?? "calls";
    const k = `${from}\0${kind}\0${to}`;
    const e = pairs.get(k) ?? { from, to, kind, attrs: { title: [], here: [], there: [] } };
    if (r.title) e.attrs.title.push(r.title);
    e.attrs.here.push(...list(r.metadata?.here));
    e.attrs.there.push(...list(r.metadata?.there));
    pairs.set(k, e);
  }
  return { layer: "systems", nodes, edges: [...pairs.values()] };
}

async function extract(ctx: LayerContext): Promise<Graph> {
  const cfg = ctx.config.layers.systems;
  if (!cfg) throw new Error("systems: no `layers.systems` in kestrel.json");
  const { fromWorkspace } = await import("@likec4/language-services/node");
  const l = await fromWorkspace(resolve(ctx.root, cfg.dir), { printErrors: false });
  try {
    if (l.hasErrors()) {
      const errs = l.getErrors().map((e) => `  ${e.sourceFsPath}:${e.line}: ${e.message}`);
      throw new Error(`systems: the LikeC4 model has errors\n${errs.join("\n")}`);
    }
    const m = await l.computedModel();
    const meta = (x: unknown) =>
      x && Object.keys(x).length ? (x as C4["elements"][0]["metadata"]) : undefined;
    return fromC4({
      elements: [...m.elements()].map((e) => ({
        id: e.id,
        kind: e.kind,
        title: e.title,
        parent: e.parent?.id,
        description: e.description.text ?? undefined,
        technology: e.technology ?? undefined,
        metadata: meta(e.$element.metadata),
      })),
      relations: [...m.relationships()].map((r) => ({
        from: r.source.id,
        to: r.target.id,
        kind: r.kind ?? undefined,
        title: r.title ?? undefined,
        metadata: meta(r.$relationship.metadata),
      })),
    });
  } finally {
    await l.dispose();
  }
}

export const systems: Layer = {
  id: "systems",
  extract,
  render: (group) => page(group),
};

/** Code paths the model names that are not on disk: `<where>: <path>`. Relative to the repo root. */
export async function seams(root: string, g: Graph): Promise<string[]> {
  const named: [string, string][] = [];
  const paths = (v: Attr | undefined) => (Array.isArray(v) ? (v as readonly string[]) : []);
  for (const n of g.nodes) for (const p of paths(n.attrs?.code)) named.push([n.id, p]);
  for (const e of g.edges)
    for (const side of ["here", "there"] as const)
      for (const p of paths(e.attrs?.[side])) named.push([`${e.from} → ${e.to}`, p]);
  const gone: string[] = [];
  for (const [where, p] of named)
    if (
      !(await access(resolve(root, p)).then(
        () => true,
        () => false,
      ))
    )
      gone.push(`${where}: ${p}`);
  return gone;
}

/** One system: what it holds, and each call out with the code on both ends. */
function page(g: Graph): Record<string, string> {
  const group = g.nodes[0]?.group;
  if (!group) return {};
  const top = g.nodes.find((n) => n.role === "system");
  const lines = [`# ${top?.attrs?.title ?? group}: system`, ""];
  if (top?.attrs?.description) lines.push(String(top.attrs.description), "");
  const tick = (x: Attr | undefined) =>
    (Array.isArray(x) ? (x as readonly string[]) : []).map((p) => `\`${p}\``).join(", ");
  const inside = g.nodes.filter((n) => n.role === "part");
  if (inside.length) {
    lines.push("## Inside", "");
    for (const n of inside)
      lines.push(
        `- **${n.attrs?.title}** (${n.attrs?.kind}${n.attrs?.technology ? `, ${n.attrs.technology}` : ""})${n.attrs?.description ? `: ${n.attrs.description}` : ""}`,
      );
    lines.push("");
  }
  if (g.edges.length) {
    lines.push("## Calls", "");
    for (const e of g.edges) {
      const titles = (e.attrs?.title as readonly string[] | undefined) ?? [];
      lines.push(
        `- ${e.from.slice("system:".length)} → ${e.to.slice("system:".length)} (${e.kind})${titles.length ? `: ${titles.join("; ")}` : ""}`,
      );
      if (tick(e.attrs?.here)) lines.push(`  - here: ${tick(e.attrs?.here)}`);
      if (tick(e.attrs?.there)) lines.push(`  - there: ${tick(e.attrs?.there)}`);
    }
    lines.push("");
  }
  return { [`${group}.md`]: lines.join("\n") };
}
