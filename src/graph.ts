/**
 * The one shape every layer gives: nodes and edges. Diff, store and cards know only this, so a
 * new tool is one adapter file. Tool detail that matters (an index's columns, a signature) goes
 * in `attrs`, which diff compares exactly.
 */
export type Attr = string | number | boolean | null | readonly string[];
export type Attrs = Readonly<Record<string, Attr>>;

/**
 * What a node is, closed so every view can group by it: the high-level view (migrations, DB,
 * backend, screens) is one row per role; a new role is a change to this list.
 */
export const ROLES = [
  "repo",
  "system",
  "service",
  "route",
  "package",
  "file",
  "export",
  "migration",
  "schema",
  "table",
  "index",
  "screen",
] as const;
export type Role = (typeof ROLES)[number];

export interface Node {
  /** Unique across layers: `@wren/outreach/src/reach-posts.ts`, `table:public.leads`. */
  id: string;
  role: Role;
  /** The node that holds this one: file → package → repo, index → table → schema. Zoom folds on it. */
  parent?: string;
  /** The file it is stored in: a package, a table, a service. Storage only; you approve the whole map. */
  group: string;
  attrs?: Attrs;
}

export interface Edge {
  from: string;
  to: string;
  /** `imports`, `references`, `calls`. */
  kind: string;
  attrs?: Attrs;
}

export interface Graph {
  layer: string;
  nodes: Node[];
  edges: Edge[];
}

export const edgeId = (e: Edge): string => `${e.from} -${e.kind}-> ${e.to}`;

const sortAttrs = (a: Attrs | undefined): Attrs | undefined => {
  if (!a) return undefined;
  const out: Record<string, Attr> = {};
  for (const k of Object.keys(a).sort()) {
    const v = a[k] as Attr;
    out[k] = Array.isArray(v) ? [...v].sort() : v;
  }
  return out;
};

function clean<T extends { attrs?: Attrs }>(x: T): T {
  const attrs = sortAttrs(x.attrs);
  const { attrs: _, ...rest } = x;
  return (attrs && Object.keys(attrs).length ? { ...rest, attrs } : rest) as T;
}

/** Sorted nodes and edges, sorted array attrs, no duplicates: the same code gives the same bytes. */
export function normalize(g: Graph): Graph {
  const nodes = new Map(g.nodes.map((n) => [n.id, clean(n)]));
  const edges = new Map(g.edges.map((e) => [edgeId(e), clean(e)]));
  const byKey = <T>(m: Map<string, T>) =>
    [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
  return { layer: g.layer, nodes: byKey(nodes), edges: byKey(edges) };
}

/** One graph per group (one file in git); an edge goes with the group of its `from` node. */
export function byGroup(g: Graph): Map<string, Graph> {
  const out = new Map<string, Graph>();
  const groupOf = new Map<string, string>();
  const part = (group: string) => {
    const p = out.get(group) ?? { layer: g.layer, nodes: [], edges: [] };
    out.set(group, p);
    return p;
  };
  for (const n of g.nodes) {
    groupOf.set(n.id, n.group);
    part(n.group).nodes.push(n);
  }
  for (const e of g.edges) part(groupOf.get(e.from) ?? "_").edges.push(e);
  return out;
}

/** Groups back into one graph. */
export function merge(layer: string, parts: Iterable<Graph>): Graph {
  const g: Graph = { layer, nodes: [], edges: [] };
  for (const p of parts) {
    g.nodes.push(...p.nodes);
    g.edges.push(...p.edges);
  }
  return normalize(g);
}
