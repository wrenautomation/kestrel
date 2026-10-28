/**
 * Who imports whom, from dependency-cruiser. Nodes: each package and each source file in it.
 * Edges: file → file, and package → package where any file crosses. Type-only imports are
 * edges too, marked `type: true`: a type still couples two files.
 */
import { existsSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { cruise } from "dependency-cruiser";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";
import type { Edge, Graph, Node } from "../graph.js";
import type { Layer } from "./layer.js";

interface Pkg {
  name: string;
  /** Repo-relative, with a trailing `/`. */
  dir: string;
}

interface CruiseModule {
  source: string;
  coreModule?: boolean;
  dependencies: {
    resolved: string;
    module: string;
    coreModule: boolean;
    dependencyTypes: string[];
  }[];
}

async function packages(root: string, globs: string[]): Promise<Pkg[]> {
  const out: Pkg[] = [];
  for await (const dir of glob(globs, { cwd: root })) {
    const file = join(root, dir, "package.json");
    if (dir.includes("node_modules") || !existsSync(file)) continue;
    const { name } = JSON.parse(await readFile(file, "utf8")) as { name?: string };
    out.push({ name: name ?? dir, dir: `${dir}/` });
  }
  // Longest dir first, so a nested package wins over its parent.
  return out.sort((a, b) => b.dir.length - a.dir.length);
}

/** `react-dom/client` → `react-dom`; `@scope/x/y` → `@scope/x`. */
const bare = (m: string) =>
  m
    .split("/")
    .slice(0, m.startsWith("@") ? 2 : 1)
    .join("/");

export const imports: Layer = {
  id: "imports",
  async extract({ root, config }) {
    const opts = config.layers.imports ?? { packages: ["packages/*", "apps/*"], exclude: [] };
    const pkgs = await packages(root, opts.packages);
    const repo = `repo:${basename(root)}`;
    const ownerOf = (path: string) => pkgs.find((p) => path.startsWith(p.dir));
    const tsConfig = ["tsconfig.json", "tsconfig.base.json"].find((f) => existsSync(join(root, f)));
    const cwd = process.cwd();
    process.chdir(root);
    let modules: CruiseModule[];
    try {
      const r = await cruise(
        pkgs.map((p) => p.dir.slice(0, -1)),
        {
          outputType: "json",
          tsPreCompilationDeps: true,
          exclude: { path: opts.exclude },
          doNotFollow: { path: "node_modules" },
          // Workspace packages resolve through their `exports` map to the source file.
          enhancedResolveOptions: {
            exportsFields: ["exports"],
            conditionNames: ["import", "types", "node", "default"],
            extensions: [".ts", ".tsx", ".js", ".mjs", ".json"],
          },
          ...(tsConfig ? { tsConfig: { fileName: tsConfig } } : {}),
        },
        undefined,
        tsConfig ? { tsConfig: extractTSConfig(tsConfig) } : undefined,
      );
      modules = JSON.parse(r.output as string).modules;
    } finally {
      process.chdir(cwd);
    }

    const nodes: Node[] = [{ id: repo, role: "repo", group: "_repo" }];
    const edges: Edge[] = [];
    const npm = new Map<string, Set<string>>();
    const crosses = new Map<string, boolean>(); // `from\0to` → every crossing is type-only
    const fileId = (p: Pkg, path: string) => `${p.name}/${relative(p.dir, path)}`;
    for (const p of pkgs) {
      nodes.push({
        id: p.name,
        role: "package",
        parent: repo,
        group: p.name,
        attrs: { dir: p.dir },
      });
      npm.set(p.name, new Set());
    }
    for (const m of modules) {
      const from = ownerOf(m.source);
      if (!from || m.source.includes("node_modules")) continue;
      const id = fileId(from, m.source);
      nodes.push({ id, role: "file", parent: from.name, group: from.name });
      for (const d of m.dependencies) {
        const type = d.dependencyTypes.includes("type-only");
        const path = d.resolved;
        const to = d.coreModule ? undefined : ownerOf(path);
        if (!to || path.includes("node_modules")) {
          npm
            .get(from.name)
            ?.add(d.coreModule ? `node:${bare(d.module.replace(/^node:/, ""))}` : bare(d.module));
          continue;
        }
        edges.push({
          from: id,
          to: fileId(to, path),
          kind: "imports",
          ...(type ? { attrs: { type } } : {}),
        });
        if (to !== from) {
          const k = `${from.name}\0${to.name}`;
          crosses.set(k, (crosses.get(k) ?? true) && type);
        }
      }
    }
    for (const [k, type] of crosses) {
      const [from, to] = k.split("\0") as [string, string];
      edges.push({ from, to, kind: "imports", ...(type ? { attrs: { type } } : {}) });
    }
    for (const n of nodes) {
      const deps = npm.get(n.id);
      if (n.role === "package" && deps?.size) n.attrs = { ...n.attrs, npm: [...deps] };
    }
    return { layer: "imports", nodes, edges };
  },
  render: (group) => page(group),
};

const mid = (id: string) => `n${id.replace(/[^A-Za-z0-9]/g, "_")}`;

/** One package: what it uses and is used by at the top, then its files and their imports. */
function page(g: Graph): Record<string, string> {
  const pkg = g.nodes.find((n) => n.role === "package" || n.role === "repo");
  if (!pkg) return {};
  const name = `${pkg.id.replace(/[/\\:]/g, "+")}.md`;
  const uses = g.edges.filter((e) => e.from === pkg.id);
  const files = g.nodes.filter((n) => n.role === "file");
  const fileIds = new Set(files.map((n) => n.id));
  const inner = g.edges.filter((e) => fileIds.has(e.from) && fileIds.has(e.to));
  const short = (id: string) => id.slice(pkg.id.length + 1);
  const lines = [`# ${pkg.id}`, "", `Role: ${pkg.role}. Files: ${files.length}.`, ""];
  if (uses.length) {
    lines.push(
      "## Uses",
      "",
      ...uses.map((e) => `- ${e.to}${e.attrs?.type ? " (types only)" : ""}`),
      "",
    );
  }
  const npm = pkg.attrs?.npm;
  if (Array.isArray(npm) && npm.length)
    lines.push("## Outside packages", "", [...npm].sort().join(", "), "");
  if (files.length) {
    // One node per top folder: a diagram of every file is too big to render past ~200 files.
    const folder = (id: string) => {
      const parts = short(id)
        .replace(/^src\//, "")
        .split("/");
      return parts.length > 1 ? `${parts[0]}/` : (parts[0] ?? "");
    };
    const links = new Map<string, boolean>(); // `from\0to` → every import is type-only
    for (const e of inner) {
      const [a, b] = [folder(e.from), folder(e.to)];
      if (a === b) continue;
      const k = `${a}\0${b}`;
      links.set(k, (links.get(k) ?? true) && e.attrs?.type === true);
    }
    const byFolder = new Map<string, string[]>();
    for (const f of files)
      byFolder.set(folder(f.id), [...(byFolder.get(folder(f.id)) ?? []), short(f.id)]);
    lines.push("## Folders", "", "Dotted: types only.", "", "```mermaid", "flowchart LR");
    for (const [f, list] of byFolder)
      lines.push(`  ${mid(f)}["${f}${list.length > 1 ? ` (${list.length})` : ""}"]`);
    for (const [k, type] of links) {
      const [a, b] = k.split("\0") as [string, string];
      lines.push(`  ${mid(a)} ${type ? "-.->" : "-->"} ${mid(b)}`);
    }
    lines.push("```", "", "## Files", "");
    for (const [f, list] of [...byFolder].sort(([a], [b]) => (a < b ? -1 : 1)))
      lines.push(`- ${f}${f.endsWith("/") ? `: ${list.sort().join(", ")}` : ""}`);
    lines.push("");
  }
  return { [name]: lines.join("\n") };
}
