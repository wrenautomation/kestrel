/**
 * The files in git: `<out>/<layer>/<group>.current.json` (every gen), `.approved.json` (only
 * `kestrel approve`), and `<group>.md` to read. You approve the whole map at once; the commit
 * is the record, and groups only keep each file and its git diff small.
 */
import { byGroup, type Graph, merge, normalize } from "./graph.js";
import { todo } from "./todo.js";

export type Side = "current" | "approved";

export interface Store {
  read(layer: string, side: Side): Promise<Graph | null>;
  /** Replaces that side for every group; groups that went away are removed. */
  write(layer: string, side: Side, g: Graph): Promise<void>;
  writePages(layer: string, pages: Record<string, string>): Promise<void>;
  /** Copies current over approved for every group of the layer; returns the groups that changed. */
  approve(layer: string): Promise<string[]>;
}

export function fileStore(root: string, out: string): Store {
  return todo(root, out, normalize, byGroup, merge);
}
