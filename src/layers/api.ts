/**
 * Each package's public interface, read from source with ts-morph: every name its `exports`
 * entries give out, with its declared signature. Source, not `.d.ts`: wren runs untranspiled.
 * Nodes: `export` (attrs: entry, declaration kind, signature text). Edges: none yet.
 */
import { todo } from "../todo.js";
import type { Layer } from "./layer.js";

export const api: Layer = {
  id: "api",
  extract: (ctx) => todo(ctx),
  render: (group) => todo(group),
};
