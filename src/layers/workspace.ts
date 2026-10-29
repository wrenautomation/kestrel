/** The repo's workspace packages and a TypeScript project over their source: shared by the adapters. */
import { existsSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Project } from "ts-morph";
import { filesOf, type Section } from "../cache.js";

export interface Pkg {
  name: string;
  /** Repo-relative, with a trailing `/`. */
  dir: string;
  /** Subpath → repo-relative source file, from `exports`; `.` for the main entry. */
  entries: Record<string, string>;
  /** package.json `description`: the box's one-liner. */
  description?: string;
  /** Every name in dependencies, devDependencies and peerDependencies. */
  deps: string[];
}

export async function packages(root: string, globs: string[]): Promise<Pkg[]> {
  const out: Pkg[] = [];
  for await (const dir of glob(globs, { cwd: root })) {
    const file = join(root, dir, "package.json");
    if (dir.includes("node_modules") || !existsSync(file)) continue;
    const json = JSON.parse(await readFile(file, "utf8")) as {
      name?: string;
      exports?: unknown;
      description?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    out.push({
      name: json.name ?? dir,
      dir: `${dir}/`,
      entries: entries(dir, json.exports),
      ...(json.description ? { description: json.description } : {}),
      deps: [json.dependencies, json.devDependencies, json.peerDependencies].flatMap((d) =>
        Object.keys(d ?? {}),
      ),
    });
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

/** Source globs a package's TS layers read, from its dir. */
export const SOURCE = ["src/**/*.{ts,tsx}", "!.test.", "!.stories."];

/** One section per package (cache.ts): `globs` from its dir, its package.json, the root tsconfig. */
export async function pkgSections(
  root: string,
  pkgs: readonly Pkg[],
  globs: readonly string[],
  skip: readonly RegExp[] = [],
  /** `layout`: a dependency counts by its file names and package.json only (imports); `keys`: by its key (types). */
  deps: "keys" | "layout" = "keys",
): Promise<Section[]> {
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const shared = ["tsconfig.json", "tsconfig.base.json"].filter((f) => existsSync(join(root, f)));
  const own = new Map(
    await Promise.all(
      pkgs.map(
        async (p) =>
          [
            p.name,
            await filesOf(
              root,
              globs.map((g) => (g.startsWith("!") ? g : `${p.dir}${g}`)),
              skip,
            ),
          ] as const,
      ),
    ),
  );
  return pkgs.map((p) => {
    const ds = p.deps.flatMap((d) => byName.get(d) ?? []).filter((d) => d !== p);
    const files = [...shared, `${p.dir}package.json`, ...(own.get(p.name) ?? [])];
    return deps === "keys"
      ? { group: p.name, files, deps: ds.map((d) => d.name) }
      : {
          group: p.name,
          files: [...files, ...ds.map((d) => `${d.dir}package.json`)],
          names: ds.flatMap((d) => own.get(d.name) ?? []),
        };
  });
}

/** One project per root, kept for the process: api and routes share it, and watch keeps it warm. */
const projects = new Map<string, { project: Project; dirs: Set<string> }>();

/** A project over the given packages' source; the type checker is built only if asked. */
export function tsProject(root: string, pkgs: readonly Pkg[]): Project {
  let held = projects.get(root);
  if (!held) {
    const tsConfig = ["tsconfig.json", "tsconfig.base.json"].find((f) => existsSync(join(root, f)));
    const project = new Project({
      ...(tsConfig ? { tsConfigFilePath: join(root, tsConfig) } : {}),
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
    });
    held = { project, dirs: new Set() };
    projects.set(root, held);
  }
  const add = pkgs.filter((p) => !held.dirs.has(p.dir));
  for (const p of add) held.dirs.add(p.dir);
  if (add.length)
    held.project.addSourceFilesAtPaths(
      add.flatMap((p) => [
        join(root, p.dir, "src/**/*.{ts,tsx}"),
        `!${join(root, p.dir, "**/*.{test,stories}.{ts,tsx}")}`,
        `!${join(root, p.dir, "**/node_modules/**")}`,
      ]),
    );
  return held.project;
}

/** Watch: a changed file read again, a new one added, a gone one dropped. Repo-relative paths. */
export function refresh(root: string, paths: readonly string[]): void {
  const held = projects.get(root);
  if (!held) return;
  for (const rel of paths) {
    if (!/\.tsx?$/.test(rel) || /\.(test|stories)\.tsx?$/.test(rel)) continue;
    const abs = join(root, rel);
    const f = held.project.getSourceFile(abs);
    if (!existsSync(abs)) {
      if (f) held.project.removeSourceFile(f);
    } else if (f) f.refreshFromFileSystemSync();
    else if ([...held.dirs].some((d) => rel.startsWith(`${d}src/`)))
      held.project.addSourceFileAtPath(abs);
  }
}

/** Comments out and whitespace folded: a reformat or a doc edit is not drift; cards hold the why. */
export const flat = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/** The first sentence, no end stop. */
export const sentence = (s: string) =>
  (s.match(/^.*?\.(\s|$)/)?.[0] ?? s).trim().replace(/\.$/, "");

/** A file's one-liner: the first sentence of the doc comment at its top. */
export function headerLine(text: string): string | undefined {
  const m = text.match(/^(?:#!.*\n)?\s*\/\*\*([\s\S]*?)\*\//);
  if (!m) return undefined;
  const body = (m[1] ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, "").trim())
    .filter((l) => !l.startsWith("@"))
    .join(" ")
    // A design pointer is for the reader of the file, not the box.
    .replace(/\s*\(designs\/[^)]*\)/g, "")
    .trim();
  return body ? sentence(body) : undefined;
}
