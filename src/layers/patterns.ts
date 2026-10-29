/**
 * The patterns a repo names, checked. A pattern card's `rule` (cards.ts `PatternRule`) over each
 * route's walk: the routes layer's `deps` and `reaches` attrs. Nodes: `pattern:<card name>`, attr
 * `card`. Edges: pattern → route, `holds` or `breaks`. An approved `breaks` is an accepted
 * exception; a new one is drift. Whole layer each gen: it reads only the cards and the routes graph.
 */
import { basename } from "node:path";
import { type PatternRule, patternCards } from "../cards.js";
import type { Edge, Graph, Node } from "../graph.js";
import type { Layer } from "./layer.js";

const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);

/** Whether `when` picks a route: it reads one of `deps` or calls one of `reaches`; none = every route. */
export function picks(
  r: PatternRule,
  deps: readonly string[],
  reaches: readonly string[],
): boolean {
  const w = r.when;
  if (!w || (!w.deps?.length && !w.reaches?.length)) return true;
  return !!(w.deps?.some((d) => deps.includes(d)) || w.reaches?.some((n) => reaches.includes(n)));
}

/** Whether a picked route holds: it calls one of `must` and none of `never`. */
export const holds = (r: PatternRule, reaches: readonly string[]): boolean =>
  (!r.must?.length || r.must.some((n) => reaches.includes(n))) &&
  !r.never?.some((n) => reaches.includes(n));

export const patterns: Layer = {
  id: "patterns",
  async extract({ root, config, prior }) {
    const { cards } = await patternCards(root, config.cards?.dir ?? "map");
    const routes = (await prior("routes"))?.nodes.filter((n) => n.role === "route") ?? [];
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    for (const c of cards) {
      const id = `pattern:${basename(c.path, ".md")}`;
      nodes.push({ id, role: "pattern", group: id.slice(8), attrs: { card: c.path } });
      for (const r of routes) {
        const reaches = list(r.attrs?.reaches);
        if (!picks(c.rule, list(r.attrs?.deps), reaches)) continue;
        edges.push({ from: id, to: r.id, kind: holds(c.rule, reaches) ? "holds" : "breaks" });
      }
    }
    return { layer: "patterns", nodes, edges };
  },
  render: (g) => page(g),
};

/** One pattern: its card, then each route that breaks it, then the count that hold. */
function page(g: Graph): Record<string, string> {
  const p = g.nodes.find((n) => n.role === "pattern");
  if (!p) return {};
  const of = (k: string) =>
    g.edges
      .filter((e) => e.kind === k)
      .map((e) => e.to)
      .sort();
  const breaks = of("breaks");
  const lines = [
    `# ${p.id}`,
    "",
    `Card: \`${String(p.attrs?.card)}\`. Holds: ${of("holds").length}. Breaks: ${breaks.length}.`,
    "",
  ];
  if (breaks.length) lines.push("## Breaks", "", ...breaks.map((b) => `- ${b}`), "");
  return { [`${p.id.replace(/[/\\:]/g, "+")}.md`]: lines.join("\n") };
}
