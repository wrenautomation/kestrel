/**
 * The files in git: `<out>/<layer>/<group>.current.json` (every gen), `.approved.json` (only
 * `kestrel approve`), and `<group>.md` to read. You approve the whole map at once; the commit
 * is the record, and groups only keep each file and its git diff small.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { byGroup, type Graph, merge, normalize } from "./graph.js";

export type Side = "current" | "approved";

export interface Store {
  read(layer: string, side: Side): Promise<Graph | null>;
  /** Replaces that side for every group; groups that went away are removed. */
  write(layer: string, side: Side, g: Graph): Promise<void>;
  /** Replaces every page of the layer. */
  writePages(layer: string, pages: Record<string, string>): Promise<void>;
  /** Copies current over approved for every group of the layer; returns the groups that changed. */
  approve(layer: string): Promise<string[]>;
}

/** `@wren/outreach` → `@wren+outreach`: a group is one flat file name. */
export const fileOf = (group: string) => group.replace(/[/\\:]/g, "+");

export function fileStore(root: string, out: string): Store {
  const dir = (layer: string) => resolve(root, out, layer);
  const files = async (layer: string, side: Side) => {
    const names = await readdir(dir(layer)).catch(() => [] as string[]);
    return names.filter((f) => f.endsWith(`.${side}.json`));
  };
  const store: Store = {
    async read(layer, side) {
      const names = await files(layer, side);
      if (!names.length) return null;
      const parts = await Promise.all(
        names.map(async (f) => JSON.parse(await readFile(join(dir(layer), f), "utf8")) as Graph),
      );
      return merge(layer, parts);
    },
    async write(layer, side, g) {
      await mkdir(dir(layer), { recursive: true });
      const parts = byGroup(normalize(g));
      const keep = new Set([...parts.keys()].map((k) => `${fileOf(k)}.${side}.json`));
      for (const f of await files(layer, side)) if (!keep.has(f)) await rm(join(dir(layer), f));
      for (const [group, part] of parts)
        await writeFile(
          join(dir(layer), `${fileOf(group)}.${side}.json`),
          `${JSON.stringify(part, null, 1)}\n`,
        );
    },
    async writePages(layer, pages) {
      await mkdir(dir(layer), { recursive: true });
      for (const f of await readdir(dir(layer)))
        if (f.endsWith(".md") && !(f in pages)) await rm(join(dir(layer), f));
      for (const [name, text] of Object.entries(pages))
        await writeFile(join(dir(layer), name), text);
    },
    async approve(layer) {
      const [cur, old] = await Promise.all([
        store.read(layer, "current"),
        store.read(layer, "approved"),
      ]);
      if (!cur) return [];
      const before = old ? byGroup(old) : new Map<string, Graph>();
      const after = byGroup(cur);
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
        (g) => JSON.stringify(before.get(g) ?? null) !== JSON.stringify(after.get(g) ?? null),
      );
      await store.write(layer, "approved", cur);
      return changed.sort();
    },
  };
  return store;
}
