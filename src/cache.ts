/**
 * Sectioned input hashes: gen extracts only the groups whose inputs changed. A section is one
 * group's input files plus the groups it depends on (their keys feed its key, so a change in
 * `@x/core` reaches every package that uses it). Group `*` = the layer as one section.
 * The cache also keeps each group's output hash: a group file that git or a peer changed is
 * extracted again, never trusted. Lives in `node_modules/.cache/kestrel`, never in git.
 */
import { createHash } from "node:crypto";
import { glob, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { byGroup, type Graph } from "./graph.js";

export interface Section {
  group: string;
  /** Repo-relative input files. */
  files: string[];
  /** Groups of the same layer whose inputs reach this one's output. */
  deps?: string[];
  /** Files whose names count, not their text (a dependency's layout, for import resolution). */
  names?: string[];
}

export const WHOLE = "*";

interface Entry {
  in: string;
  out: string;
}
type Ledger = Record<string, Entry>;

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Repo-relative files that `globs` match, with `!` globs and `skip` patterns left out. */
export async function filesOf(
  root: string,
  globs: readonly string[],
  skip: readonly RegExp[] = [],
): Promise<string[]> {
  const yes = globs.filter((g) => !g.startsWith("!"));
  const no = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
  if (!yes.length) return [];
  const out: string[] = [];
  for await (const f of glob(yes, { cwd: root, exclude: (p) => no.some((n) => p.includes(n)) }))
    if (!f.includes("node_modules") && !skip.some((r) => r.test(f))) out.push(f);
  return out.sort();
}

/** Each section's key: its files, its deps' keys, and `salt` (kestrel version, layer config). */
export async function keysOf(
  root: string,
  sections: readonly Section[],
  salt: string,
): Promise<Map<string, string>> {
  const by = new Map(sections.map((s) => [s.group, s]));
  const own = new Map<string, string>();
  await Promise.all(
    sections.map(async (s) => {
      const parts = await Promise.all(
        s.files.map(async (f) => `${f}\0${sha(await readFile(join(root, f)).catch(() => ""))}`),
      );
      own.set(s.group, sha([...parts, ...(s.names ?? [])].join("\n")));
    }),
  );
  const keys = new Map<string, string>();
  const key = (g: string, path: Set<string>): string => {
    const done = keys.get(g);
    if (done) return done;
    // A dependency cycle: the loop's members feed each other's own hash, not their keys.
    const deps = (by.get(g)?.deps ?? [])
      .filter((d) => by.has(d) && d !== g)
      .sort()
      .map((d) => (path.has(d) ? (own.get(d) ?? "") : key(d, new Set([...path, d]))));
    const k = sha([salt, own.get(g) ?? "", ...deps].join("\n"));
    keys.set(g, k);
    return k;
  };
  for (const s of sections) key(s.group, new Set([s.group]));
  return keys;
}

const outOf = (part: Graph | undefined) => (part ? sha(JSON.stringify(part)) : "");

export interface Plan {
  /** Groups to extract; `null` = the whole layer. Empty = nothing to do. */
  only: Set<string> | null;
  /** Groups whose sections went away. */
  gone: Set<string>;
  keys: Map<string, string>;
}

export function cache(root: string) {
  const dir = resolve(root, "node_modules/.cache/kestrel");
  const file = (layer: string) => join(dir, `${layer}.json`);
  const load = async (layer: string): Promise<Ledger> =>
    JSON.parse(await readFile(file(layer), "utf8").catch(() => "{}")) as Ledger;
  return {
    /** What to extract, from the keys and the stored current graph. */
    async plan(layer: string, keys: Map<string, string>, current: Graph | null): Promise<Plan> {
      const led = await load(layer);
      const parts = current ? byGroup(current) : new Map<string, Graph>();
      const stale = (g: string) => {
        const e = led[g];
        const out =
          g === WHOLE ? (current ? sha(JSON.stringify(current)) : "") : outOf(parts.get(g));
        return !e || e.in !== keys.get(g) || e.out !== out;
      };
      const gone = new Set(Object.keys(led).filter((g) => !keys.has(g)));
      if (keys.has(WHOLE)) return { only: stale(WHOLE) ? null : new Set(), gone, keys };
      const only = new Set([...keys.keys()].filter(stale));
      return { only, gone, keys };
    },
    /** Records the keys and the output that gen just wrote. */
    async save(layer: string, keys: Map<string, string>, written: Graph): Promise<void> {
      const parts = byGroup(written);
      const led: Ledger = {};
      for (const [g, k] of keys)
        led[g] = { in: k, out: g === WHOLE ? sha(JSON.stringify(written)) : outOf(parts.get(g)) };
      await mkdir(dir, { recursive: true });
      await writeFile(file(layer), JSON.stringify(led));
    },
  };
}
