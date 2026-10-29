/**
 * The health report: signals, not a gate. Cycles, flat folders, fan-in and fan-out, and weak
 * interfaces come from the stored graphs; duplicates from jscpd; unused exports, types and
 * dependencies from knip; pins behind from the npm registry. It is not part of the map, so nothing approves it. Package layers and
 * package cycles are the repo's own gate (wren `scripts/layers-guard.mjs`); this adds the file
 * cycles inside a package. jscpd and knip are heavy: the caller runs `kestrel health` under the
 * repo's check lock.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Graph } from "./graph.js";

const run = promisify(execFile);

/** A folder with more boxes than this reads as a list, not a graph (the view's grid). */
export const FLAT_OVER = 40;
const TOP = 15;

export interface Clone {
  lines: number;
  /** `path:start-end`, repo-relative. */
  a: string;
  b: string;
}

export interface Unused {
  file: string;
  name: string;
}

export interface Health {
  /** File cycles by runtime imports (type-only imports leave no cycle at run time). */
  cycles: string[][];
  /** Folders with more than FLAT_OVER files and folders in them. */
  flat: { folder: string; boxes: number }[];
  fanIn: { file: string; n: number }[];
  fanOut: { file: string; n: number }[];
  /** Exports with no declared type, per package, most first. */
  inferred: { pkg: string; n: number; of: number }[];
  duplicates?: { percent: number; clones: number; lines: number; top: Clone[] };
  unused?: { exports: Unused[]; types: Unused[]; dependencies: Unused[] };
  /** A pin in an owned scope with newer publishes: `n` versions after it. */
  behind?: Behind[];
}

export interface Behind {
  pkg: string;
  name: string;
  pinned: string;
  latest: string;
  n: number;
}

/** Package `versions` attrs (imports layer) in `scopes`, against each name's published list. */
export async function pinsBehind(
  imports: Graph | null,
  scopes: readonly string[],
  /** Published versions, oldest first; the registry by default. */
  published: (name: string) => Promise<string[]> = async (name) =>
    JSON.parse((await run("npm", ["view", name, "versions", "--json"])).stdout) as string[],
): Promise<Behind[]> {
  if (!scopes.length) return [];
  const pins: Omit<Behind, "latest" | "n">[] = [];
  for (const n of imports?.nodes ?? [])
    for (const v of Array.isArray(n.attrs?.versions) ? (n.attrs.versions as string[]) : []) {
      const i = v.lastIndexOf("@");
      const name = v.slice(0, i);
      if (scopes.some((s) => name.startsWith(s)))
        pins.push({ pkg: n.id, name, pinned: v.slice(i + 1) });
    }
  const lists = new Map<string, string[]>();
  await Promise.all(
    [...new Set(pins.map((p) => p.name))].map(async (n) => {
      const l = await published(n).catch(() => []);
      lists.set(n, Array.isArray(l) ? l : [l]);
    }),
  );
  return pins
    .flatMap((p) => {
      const l = lists.get(p.name) ?? [];
      const at = l.indexOf(p.pinned);
      const latest = l.at(-1);
      return at >= 0 && latest && at < l.length - 1 ? [{ ...p, latest, n: l.length - 1 - at }] : [];
    })
    .sort((a, b) => b.n - a.n || a.pkg.localeCompare(b.pkg) || a.name.localeCompare(b.name));
}

/** Tarjan's strongly connected components; each with more than one file is a cycle. */
export function cycles(g: Graph): string[][] {
  const next = new Map<string, string[]>();
  for (const e of g.edges) {
    if (e.kind !== "imports" || e.attrs?.type === true) continue;
    next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const out: string[][] = [];
  let i = 0;
  const visit = (v: string) => {
    index.set(v, i);
    low.set(v, i);
    i++;
    stack.push(v);
    on.add(v);
    for (const w of next.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
    }
    if (low.get(v) !== index.get(v)) return;
    const scc: string[] = [];
    for (let w = stack.pop(); w !== undefined; w = stack.pop()) {
      on.delete(w);
      scc.push(w);
      if (w === v) break;
    }
    if (scc.length > 1) out.push(scc.sort());
  };
  for (const v of [...next.keys()].sort()) if (!index.has(v)) visit(v);
  return out.sort((a, b) => b.length - a.length || (a[0] as string).localeCompare(b[0] as string));
}

/** Signals the imports and api graphs already hold. */
export function fromGraphs(imports: Graph | null, api: Graph | null): Health {
  const files = (imports?.nodes ?? []).filter((n) => n.role === "file");
  // A folder's boxes: its files and the folders right under it.
  const boxes = new Map<string, Set<string>>();
  for (const f of files) {
    const parts = f.id
      .slice((f.parent?.length ?? 0) + 1)
      .replace(/^src\//, "")
      .split("/");
    for (let d = 0; d < parts.length; d++) {
      const folder = `${f.parent}/${parts.slice(0, d).join("/")}`.replace(/\/$/, "");
      const set = boxes.get(folder) ?? new Set<string>();
      set.add(parts[d] as string);
      boxes.set(folder, set);
    }
  }
  const flat = [...boxes]
    .filter(([, s]) => s.size > FLAT_OVER)
    .map(([folder, s]) => ({ folder, boxes: s.size }))
    .sort((a, b) => b.boxes - a.boxes);
  const fin = new Map<string, number>();
  const fout = new Map<string, number>();
  for (const e of imports?.edges ?? []) {
    if (e.kind !== "imports") continue;
    fin.set(e.to, (fin.get(e.to) ?? 0) + 1);
    fout.set(e.from, (fout.get(e.from) ?? 0) + 1);
  }
  const top = (m: Map<string, number>) =>
    [...m]
      .map(([file, n]) => ({ file, n }))
      .sort((a, b) => b.n - a.n || a.file.localeCompare(b.file))
      .slice(0, TOP);
  const per = new Map<string, { n: number; of: number }>();
  for (const n of api?.nodes ?? []) {
    if (n.role !== "export") continue;
    const p = per.get(n.group) ?? { n: 0, of: 0 };
    p.of++;
    if (n.attrs?.inferred) p.n++;
    per.set(n.group, p);
  }
  const inferred = [...per]
    .filter(([, p]) => p.n)
    .map(([pkg, p]) => ({ pkg, ...p }))
    .sort((a, b) => b.n - a.n || a.pkg.localeCompare(b.pkg));
  return {
    cycles: imports ? cycles(imports) : [],
    flat,
    fanIn: top(fin),
    fanOut: top(fout),
    inferred,
  };
}

interface JscpdFile {
  name: string;
  startLoc: { line: number };
  endLoc: { line: number };
}

/** jscpd's JSON report, paths made repo-relative. */
export function fromJscpd(report: unknown, root: string): NonNullable<Health["duplicates"]> {
  const r = report as {
    statistics: { total: { percentage: number; clones: number; duplicatedLines: number } };
    duplicates: { lines: number; firstFile: JscpdFile; secondFile: JscpdFile }[];
  };
  const at = (f: JscpdFile) => `${relative(root, f.name)}:${f.startLoc.line}-${f.endLoc.line}`;
  const t = r.statistics.total;
  return {
    percent: Math.round(t.percentage * 100) / 100,
    clones: t.clones,
    lines: t.duplicatedLines,
    top: [...r.duplicates]
      .sort((a, b) => b.lines - a.lines)
      .slice(0, TOP)
      .map((d) => ({ lines: d.lines, a: at(d.firstFile), b: at(d.secondFile) })),
  };
}

/** knip's JSON report. Unused files are left out: they need the repo's entries in a knip config. */
export function fromKnip(report: unknown): NonNullable<Health["unused"]> {
  const r = report as {
    issues: {
      file: string;
      exports: { name: string }[];
      types: { name: string }[];
      dependencies: { name: string }[];
    }[];
  };
  const pick = (k: "exports" | "types" | "dependencies") =>
    r.issues.flatMap((i) => i[k].map((x) => ({ file: i.file, name: x.name })));
  return { exports: pick("exports"), types: pick("types"), dependencies: pick("dependencies") };
}

/** kestrel's own install of a tool: `dist/` and `src/` sit next to `node_modules/`. */
const bin = (name: string) =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin", name);

export interface ToolOptions {
  /** Folders jscpd reads, from the repo root. */
  paths: string[];
  ignore: string[];
}

export async function runTools(
  root: string,
  o: ToolOptions,
): Promise<Pick<Health, "duplicates" | "unused">> {
  const out = await mkdtemp(join(tmpdir(), "kestrel-jscpd-"));
  try {
    await run(
      bin("jscpd"),
      [
        "--silent",
        "--absolute",
        "--reporters",
        "json",
        "--output",
        out,
        "--format",
        "typescript,tsx",
        "--ignore",
        o.ignore.join(","),
        ...o.paths,
      ],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
    );
    const duplicates = fromJscpd(
      JSON.parse(await readFile(join(out, "jscpd-report.json"), "utf8")),
      root,
    );
    const { stdout } = await run(bin("knip"), ["--reporter", "json", "--no-exit-code"], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { duplicates, unused: fromKnip(JSON.parse(stdout)) };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

/** The report as a page: counts first, then each list. */
const n_ = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
/** The key with the most rows: `[key, count]`. */
const most = <T>(list: readonly T[], key: (t: T) => string): [string, number] | undefined => {
  const m = new Map<string, number>();
  for (const t of list) m.set(key(t), (m.get(key(t)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1])[0];
};
const pkgOf = (file: string) => file.split("/").slice(0, 2).join("/");

/** One sentence per signal with a count: what it is, the worst case, what to do. Fix order. */
export function plain(h: Health): string[] {
  const t = (s: string) => `\`${s}\``;
  const out: string[] = [];
  if (h.behind?.length) {
    const w = [...h.behind].sort((a, b) => b.n - a.n)[0] as Behind;
    const pkgs = h.behind.filter((b) => b.name === w.name && b.pinned === w.pinned).length;
    out.push(
      `${n_(h.behind.length, "pin is", "pins are")} behind a newer publish. The worst: ${t(`${w.name}@${w.pinned}`)}, ${w.n} behind ${w.latest}, in ${n_(pkgs, "package")}. Bump each scope in one change.`,
    );
  }
  if (h.cycles.length) {
    const big = [...h.cycles].sort((a, b) => b.length - a.length)[0] as string[];
    out.push(
      `${n_(h.cycles.length, "file cycle")}: files that import each other in a loop. The largest has ${big.length} files, from ${t(big[0] as string)}. Move what they share into one file that imports none of them.`,
    );
  }
  if (h.unused?.dependencies.length)
    out.push(
      `${n_(h.unused.dependencies.length, "dependency", "dependencies")} no code imports: ${h.unused.dependencies
        .slice(0, 5)
        .map((d) => t(d.name))
        .join(
          ", ",
        )}${h.unused.dependencies.length > 5 ? " and more" : ""}. Remove them from package.json.`,
    );
  const dead = [...(h.unused?.exports ?? []), ...(h.unused?.types ?? [])];
  if (dead.length) {
    const [pkg, k] = most(dead, (u) => pkgOf(u.file)) as [string, number];
    out.push(
      `${n_(dead.length, "export")} nothing imports. Most are in ${t(pkg)} (${k}). Delete them, or stop the export.`,
    );
  }
  if (h.flat.length) {
    const f = [...h.flat].sort((a, b) => b.boxes - a.boxes)[0] as Health["flat"][number];
    out.push(
      `${n_(h.flat.length, "folder")} over ${FLAT_OVER} boxes: too flat to read as a graph. The largest: ${t(f.folder)} (${f.boxes}). Group its files by job.`,
    );
  }
  if (h.duplicates?.clones) {
    const c = h.duplicates.top[0];
    out.push(
      `${h.duplicates.percent}% of lines are copies (${n_(h.duplicates.clones, "clone")}).${c ? ` The largest: ${c.lines} lines, ${t(c.a)} and ${t(c.b)}.` : ""} Share the part where both copies change together.`,
    );
  }
  const inferred = h.inferred.reduce((a, p) => a + p.n, 0);
  if (inferred) {
    const p = h.inferred[0] as Health["inferred"][number];
    out.push(
      `${n_(inferred, "export")} with no declared type: the interface is whatever the code returns. Most: ${t(p.pkg)} (${p.n} of ${p.of}). Declare the type where other packages use it.`,
    );
  }
  return out;
}

export function page(h: Health): string {
  const L: string[] = ["# Health", ""];
  const tick = (s: string) => `\`${s}\``;
  L.push("Signals, not a gate. Package layers and package cycles are the repo's own gate.", "");
  const read = plain(h);
  if (read.length) L.push("## Read first", "", ...read.map((s, i) => `${i + 1}. ${s}`), "");
  L.push(
    "| Signal | Count |",
    "|---|---|",
    `| File cycles | ${h.cycles.length} |`,
    `| Flat folders (over ${FLAT_OVER} boxes) | ${h.flat.length} |`,
    `| Inferred exports | ${h.inferred.reduce((a, p) => a + p.n, 0)} |`,
  );
  if (h.duplicates)
    L.push(
      `| Duplicated lines | ${h.duplicates.lines} (${h.duplicates.percent}%, ${h.duplicates.clones} clones) |`,
    );
  if (h.unused)
    L.push(
      `| Unused exports | ${h.unused.exports.length} |`,
      `| Unused types | ${h.unused.types.length} |`,
      `| Unused dependencies | ${h.unused.dependencies.length} |`,
    );
  if (h.behind) L.push(`| Pins behind | ${h.behind.length} |`);
  L.push("");
  if (h.behind?.length) {
    L.push("## Pins behind", "", "| Package | Pin | Latest | Behind |", "|---|---|---|---|");
    for (const b of h.behind)
      L.push(`| ${tick(b.pkg)} | ${tick(`${b.name}@${b.pinned}`)} | ${b.latest} | ${b.n} |`);
    L.push("");
  }
  if (h.cycles.length) {
    L.push(
      "## File cycles",
      "",
      "Each line is one set of files that import each other in a loop.",
      "",
    );
    for (const c of h.cycles) L.push(`- ${c.map(tick).join(", ")}`);
    L.push("");
  }
  if (h.flat.length) {
    L.push("## Flat folders", "", "| Folder | Boxes |", "|---|---|");
    for (const f of h.flat) L.push(`| ${tick(f.folder)} | ${f.boxes} |`);
    L.push("");
  }
  L.push("## Most imported", "", "| File | Imported by |", "|---|---|");
  for (const f of h.fanIn) L.push(`| ${tick(f.file)} | ${f.n} |`);
  L.push("", "## Most imports", "", "| File | Imports |", "|---|---|");
  for (const f of h.fanOut) L.push(`| ${tick(f.file)} | ${f.n} |`);
  L.push("");
  if (h.inferred.length) {
    L.push(
      "## Inferred exports",
      "",
      "No declared type: a weak interface.",
      "",
      "| Package | Inferred | Exports |",
      "|---|---|---|",
    );
    for (const p of h.inferred) L.push(`| ${tick(p.pkg)} | ${p.n} | ${p.of} |`);
    L.push("");
  }
  if (h.duplicates?.top.length) {
    L.push("## Largest clones", "", "| Lines | One | Other |", "|---|---|---|");
    for (const c of h.duplicates.top) L.push(`| ${c.lines} | ${tick(c.a)} | ${tick(c.b)} |`);
    L.push("");
  }
  if (h.unused) {
    const by = (list: Unused[]) => {
      const m = new Map<string, number>();
      for (const u of list) {
        const k = u.file.split("/").slice(0, 2).join("/");
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      return [...m].sort((a, b) => b[1] - a[1]);
    };
    L.push(
      "## Unused, by package",
      "",
      "From knip. Unused files are left out: they need the repo's entries in a knip config.",
      "",
      "| Package | Exports | Types | Dependencies |",
      "|---|---|---|---|",
    );
    const keys = new Set(
      [h.unused.exports, h.unused.types, h.unused.dependencies].flatMap((l) =>
        by(l).map(([k]) => k),
      ),
    );
    const count = (l: Unused[], k: string) => by(l).find(([x]) => x === k)?.[1] ?? 0;
    for (const k of [...keys].sort())
      L.push(
        `| ${tick(k)} | ${count(h.unused.exports, k)} | ${count(h.unused.types, k)} | ${count(h.unused.dependencies, k)} |`,
      );
    L.push("");
    if (h.unused.dependencies.length) {
      L.push("### Unused dependencies", "");
      for (const u of h.unused.dependencies) L.push(`- ${tick(u.name)} in ${tick(u.file)}`);
      L.push("");
    }
  }
  return `${L.join("\n")}`;
}
