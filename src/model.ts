/**
 * The one shape every layer gives: nodes and edges. Diff, store and cards know only this, so a
 * new tool is one adapter file. Tool detail that matters (an index's columns, a signature) goes
 * in `attrs`, which diff compares exactly.
 */
import { todo } from "./todo.js";

export type Attr = string | number | boolean | null | readonly string[];
export type Attrs = Readonly<Record<string, Attr>>;

export interface Node {
  /** Unique in its layer: `@wren/outreach/src/reach-posts.ts`, `table:leads`. */
  id: string;
  /** Layer-specific: `package`, `file`, `export`, `table`, `index`, `system`. */
  kind: string;
  /** The unit you approve and the file it is stored in: a package, a table, a system. */
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

/** One graph per group; an edge goes with the group of its `from` node. */
export function byGroup(g: Graph): Map<string, Graph> {
  return todo(g);
}

/** Groups back into one graph. */
export function merge(layer: string, parts: Iterable<Graph>): Graph {
  return todo(layer, parts);
}
