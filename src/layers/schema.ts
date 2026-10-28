/**
 * Tables, columns, keys and indexes, from `tbls out -t json` on a migrated Postgres. A live
 * database, not the Drizzle files: indexes and constraints a migration added by hand show too.
 * Nodes: `table` (attrs: columns with type and null), `index` (attrs: columns, unique, method).
 * Edges: `references` per foreign key, with the column pair.
 */
import { todo } from "../todo.js";
import type { Layer } from "./layer.js";

export const schema: Layer = {
  id: "schema",
  extract: (ctx) => todo(ctx),
  render: (group) => todo(group),
};
