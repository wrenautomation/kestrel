/**
 * Repos, services and the seams between them, from a LikeC4 model. The only hand-written layer,
 * so `seams` checks it: each relation names a code path on both ends, and both must exist.
 * Nodes: `system`, `service`. Edges: `calls` (attrs: the two code paths).
 */
import { todo } from "../todo.js";
import type { Layer, LayerContext } from "./layer.js";

export const systems: Layer = {
  id: "systems",
  extract: (ctx) => todo(ctx),
  render: (group) => todo(group),
};

/** Relations whose code path on either end is missing. */
export async function seams(ctx: LayerContext): Promise<string[]> {
  return todo(ctx);
}
