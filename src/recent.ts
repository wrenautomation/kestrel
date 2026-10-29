/**
 * Recent work: where the last days' commits landed, by package and file. One `git log --numstat`
 * pass; measured, never approved (a report like health, not a layer). Local: git can rebuild it.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Graph } from "./graph.js";

const run = promisify(execFile);
const TOP = 15;

export interface Churn {
  commits: number;
  files: number;
  added: number;
  removed: number;
}

export interface Recent {
  days: number;
  commits: number;
  /** Package id (outside packages: its top `dir/`, or a root file) → its churn, most commits first. */
  packages: ({ id: string } & Churn)[];
  /** Every repo path touched, most commits first (the page shows the top). */
  files: ({ path: string } & Omit<Churn, "files">)[];
}

export interface Commit {
  sha: string;
  files: { path: string; added: number; removed: number }[];
}

/** `git log --numstat` with a NUL before each commit; binary files count 0 lines. */
export function parseLog(text: string): Commit[] {
  return text
    .split("\0")
    .filter((c) => c.trim())
    .map((c) => {
      const [sha = "", ...lines] = c.split("\n");
      return {
        sha: sha.trim(),
        files: lines
          .map((l) => l.split("\t"))
          .filter((p) => p.length === 3)
          .map(([a, r, path]) => ({
            path: renamed(path as string),
            added: Number(a) || 0,
            removed: Number(r) || 0,
          })),
      };
    });
}

/** `a/{old => new}/b` or `old => new` → the new path. */
const renamed = (p: string) =>
  p.includes(" => ")
    ? p
        .replace(/\{([^}]*) => ([^}]*)\}/, "$2")
        .replace(/^.* => /, "")
        .replace(/\/\//g, "/")
    : p;

export function recentOf(commits: readonly Commit[], imports: Graph | null, days: number): Recent {
  const dirs = (imports?.nodes ?? [])
    .filter((n) => n.role === "package" && n.attrs?.dir)
    .map((n) => [n.id, String(n.attrs?.dir)] as const)
    .sort(([, a], [, b]) => b.length - a.length);
  const pkgOf = (path: string) =>
    dirs.find(([, d]) => path.startsWith(d))?.[0] ??
    (path.includes("/") ? `${path.split("/")[0]}/` : path);
  const pkgs = new Map<string, Churn & { seen: Set<string>; paths: Set<string> }>();
  const files = new Map<string, Omit<Churn, "files"> & { seen: Set<string> }>();
  for (const c of commits)
    for (const f of c.files) {
      const id = pkgOf(f.path);
      const p = pkgs.get(id) ?? {
        commits: 0,
        files: 0,
        added: 0,
        removed: 0,
        seen: new Set(),
        paths: new Set(),
      };
      p.seen.add(c.sha);
      p.paths.add(f.path);
      p.added += f.added;
      p.removed += f.removed;
      pkgs.set(id, p);
      const x = files.get(f.path) ?? { commits: 0, added: 0, removed: 0, seen: new Set() };
      x.seen.add(c.sha);
      x.added += f.added;
      x.removed += f.removed;
      files.set(f.path, x);
    }
  const byCommits = <T extends { commits: number; added: number }>(a: T, b: T) =>
    b.commits - a.commits || b.added - a.added;
  return {
    days,
    commits: commits.length,
    packages: [...pkgs]
      .map(([id, p]) => ({
        id,
        commits: p.seen.size,
        files: p.paths.size,
        added: p.added,
        removed: p.removed,
      }))
      .sort(byCommits),
    files: [...files]
      .map(([path, f]) => ({ path, commits: f.seen.size, added: f.added, removed: f.removed }))
      .sort(byCommits),
  };
}

export async function readRecent(root: string, imports: Graph | null, days: number) {
  const { stdout } = await run(
    "git",
    ["log", `--since=${days}.days`, "--no-merges", "--numstat", "--format=%x00%H"],
    { cwd: root, maxBuffer: 256 * 1024 * 1024 },
  );
  return recentOf(parseLog(stdout), imports, days);
}

export function recentPage(r: Recent): string {
  const t = (s: string) => `\`${s}\``;
  const L = [
    "# Recent work",
    "",
    `The last ${r.days} days: ${r.commits} commits, merges left out. Measured, never approved.`,
    "",
    "## By package",
    "",
    "| Package | Commits | Files | Lines |",
    "|---|---|---|---|",
    ...r.packages.map(
      (p) => `| ${t(p.id)} | ${p.commits} | ${p.files} | +${p.added} −${p.removed} |`,
    ),
    "",
    "## Most changed files",
    "",
    "| File | Commits | Lines |",
    "|---|---|---|",
    ...r.files
      .slice(0, TOP)
      .map((f) => `| ${t(f.path)} | ${f.commits} | +${f.added} −${f.removed} |`),
    "",
  ];
  return L.join("\n");
}
