/** The repo's workspace packages and a TypeScript project over their source: shared by the adapters. */
import { existsSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Project } from "ts-morph";

export interface Pkg {
  name: string;
  /** Repo-relative, with a trailing `/`. */
  dir: string;
  /** Subpath → repo-relative source file, from `exports`; `.` for the main entry. */
  entries: Record<string, string>;
}

export async function packages(root: string, globs: string[]): Promise<Pkg[]> {
  const out: Pkg[] = [];
  for await (const dir of glob(globs, { cwd: root })) {
    const file = join(root, dir, "package.json");
    if (dir.includes("node_modules") || !existsSync(file)) continue;
    const json = JSON.parse(await readFile(file, "utf8")) as { name?: string; exports?: unknown };
    out.push({ name: json.name ?? dir, dir: `${dir}/`, entries: entries(dir, json.exports) });
  }
  // Longest dir first, so a nested package wins over its parent.
  return out.sort((a, b) => b.dir.length - a.dir.length);
}

/** Source entries only: a conditional entry takes `types`, then `import`, then `default`. */
function entries(dir: string, exp: unknown): Record<string, string> {
  if (!exp) return {};
  const map =
    typeof exp === "string" || !Object.keys(exp).some((k) => k.startsWith("."))
      ? { ".": exp }
      : (exp as Record<string, unknown>);
  const out: Record<string, string> = {};
  for (const [sub, v] of Object.entries(map)) {
    const c = v as Record<string, unknown> | string | null;
    const path = typeof c === "string" ? c : (c?.types ?? c?.import ?? c?.default);
    if (typeof path === "string" && /\.(m?ts|tsx)$/.test(path) && !sub.includes("*"))
      out[sub] = join(dir, path);
  }
  return out;
}

/** One project over the given packages' source; the type checker is built only if asked. */
export function tsProject(root: string, pkgs: readonly Pkg[]): Project {
  const tsConfig = ["tsconfig.json", "tsconfig.base.json"].find((f) => existsSync(join(root, f)));
  const project = new Project({
    ...(tsConfig ? { tsConfigFilePath: join(root, tsConfig) } : {}),
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });
  project.addSourceFilesAtPaths(
    pkgs.flatMap((p) => [
      join(root, p.dir, "src/**/*.{ts,tsx}"),
      `!${join(root, p.dir, "**/*.{test,stories}.{ts,tsx}")}`,
      `!${join(root, p.dir, "**/node_modules/**")}`,
    ]),
  );
  return project;
}

/** Comments out and whitespace folded: a reformat or a doc edit is not drift; cards hold the why. */
export const flat = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
