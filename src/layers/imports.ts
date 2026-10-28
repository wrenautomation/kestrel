/**
 * Who imports whom, from dependency-cruiser. Nodes: each package and each source file in it.
 * Edges: file → file, and package → package where any file crosses. Type-only imports are
 * edges too, marked `type: true`: a type still couples two files.
 */
import { todo } from "../todo.js";
import type { Layer } from "./layer.js";

export const imports: Layer = {
  id: "imports",
  extract: (ctx) => todo(ctx),
  render: (group) => todo(group),
};
