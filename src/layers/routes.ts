/**
 * What can be called from outside a process: Restate handlers and HTTP routes. They are
 * registered, not exported, so `api` misses them. Read with ts-morph from the registration call:
 * `restate.service|object|workflow({ name, handlers: { h: (ctx, req: In): Promise<Out> } })`.
 * Nodes: `service`, and a `route` per handler (attrs: input and output type text). Edges: none
 * yet; calls between services are the `systems` layer's.
 */
import { todo } from "../todo.js";
import type { Layer } from "./layer.js";

export const routes: Layer = {
  id: "routes",
  extract: (ctx) => todo(ctx),
  render: (group) => todo(group),
};
