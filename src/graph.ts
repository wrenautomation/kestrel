/**
 * The one shape every layer gives: nodes and edges. Diff, store and cards know only this, so a
 * new tool is one adapter file. Tool detail that matters (an index's columns, a signature) goes
 * in `attrs`, which diff compares exactly.
 */
import { todo } from "./todo.js";

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

/** Sorted nodes and edges, sorted array attrs: the same code gives the same bytes. */
export function normalize(g: Graph): Graph {
  return todo(g);
}

/** One graph per group (one file in git); an edge goes with the group of its `from` node. */
export function byGroup(g: Graph): Map<string, Graph> {
  return todo(g);
}

/** Groups back into one graph. */
export function merge(layer: string, parts: Iterable<Graph>): Graph {
  return todo(layer, parts);
}
