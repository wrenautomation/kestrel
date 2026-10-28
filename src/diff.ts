/** Approved vs current, per group: what was added, removed or changed. */
import type { Attrs, Graph } from "./graph.js";
import { todo } from "./todo.js";

export type Change =
  | { op: "add" | "remove"; what: "node" | "edge"; group: string; id: string; attrs?: Attrs }
  | { op: "change"; what: "node" | "edge"; group: string; id: string; before: Attrs; after: Attrs };

/** Edge ids are `from -kind-> to`. Empty when the two graphs are the same. */
export function diff(approved: Graph, current: Graph): Change[] {
  return todo(approved, current);
}

/** One line per change, grouped, for the gate's failure output. */
export function formatChanges(changes: readonly Change[]): string {
  return todo(changes);
}
