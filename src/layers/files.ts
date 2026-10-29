/** The imports graph read as repo files: shared by the layers that walk it (systems, ui). */
import { join } from "node:path";
import type { Graph } from "../graph.js";

/** File id ↔ repo path. */
export function paths(imports: Graph) {
  const dir = new Map<string, string>();
  for (const n of imports.nodes)
    if (n.role === "package" && typeof n.attrs?.dir === "string") dir.set(n.id, n.attrs.dir);
  const pathOf = new Map<string, string>();
  for (const n of imports.nodes) {
    const d = n.parent ? dir.get(n.parent) : undefined;
    if (n.role === "file" && n.parent && d !== undefined)
      pathOf.set(n.id, join(d, n.id.slice(n.parent.length + 1)));
  }
  return { pathOf, idOf: new Map([...pathOf].map(([id, p]) => [p, id])) };
}

/** Files reached from an entry over runtime imports, type-only left out. Edges indexed once. */
export function reach(imports: Graph): (entry: string) => Set<string> {
  const next = new Map<string, string[]>();
  for (const e of imports.edges)
    if (e.kind === "imports" && !e.attrs?.type) {
      const to = next.get(e.from);
      if (to) to.push(e.to);
      else next.set(e.from, [e.to]);
    }
  return (entry) => {
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const t of next.get(id) ?? []) if (!seen.has(t)) stack.push(t);
    }
    return seen;
  };
}
