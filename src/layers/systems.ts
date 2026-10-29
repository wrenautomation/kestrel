/**
 * Repos, deploy units and the links between them, from the code. Only what code cannot say is
 * written by hand: the residue in kestrel.json (`layers.systems`).
 *
 * Units (role `part`): `wrangler.toml` (a Worker and its D1, KV, R2 and service bindings),
 * Terraform (Lambda functions, instances, buckets, CloudFront), compose files (one per service),
 * and a `# @unit [kind:]name: one line` tag in any other deploy file (a container script, a
 * systemd unit). A unit's bundle is every file the imports graph reaches from its entry, type-only
 * imports left out. A fact in a bundled file is a link from that unit: an env var the residue
 * maps to a target, an import of a vendor SDK or a sibling repo's package, a Restate service it
 * serves. The file is the link's `here`. A route's own packages (routes attr `npm`) that map to a
 * target give a `uses` edge from the route itself.
 *
 * Ids: `system:<id>` for a repo or vendor, `system:<repo>.<kind>:<name>` for a unit. Edge kinds:
 * `calls` (env), `uses` (import, package dep), `binds` (Worker binding), `invokes` (Restate).
 * Facts on one pair and kind merge into one edge: titles and files join.
 */
import { access, glob, readFile } from "node:fs/promises";
import { basename, dirname, join, matchesGlob, resolve } from "node:path";
import { parse as hcl } from "@cdktf/hcl2json";
import { parse as toml } from "smol-toml";
import { isMap, isScalar, parseDocument } from "yaml";
import { filesOf, WHOLE } from "../cache.js";
import type { SystemsConfig } from "../config.js";
import type { Attr, Edge, Graph, Node } from "../graph.js";
import { paths, reach } from "./files.js";
import type { Layer, LayerContext } from "./layer.js";
import { sentence } from "./workspace.js";

export interface Unit {
  /** `<kind>:<name>`: `worker:portal`, `lambda:worker`, `container:valkey`. */
  key: string;
  title: string;
  technology?: string | undefined;
  description?: string | undefined;
  /** Repo-relative: the deploy file, then the entry. */
  code: string[];
  entry?: string | undefined;
  /** Unit key it runs on. */
  host?: string | undefined;
}

export interface Link {
  from: string;
  to: string;
  kind: "calls" | "uses" | "binds" | "invokes";
  title: string;
  here?: string | undefined;
}

const tick = (s: string) => `\`${s}\``;
/** `#` lines above line `at` (one blank line between is fine), joined. */
function commentAbove(lines: readonly string[], at: number): string {
  const out: string[] = [];
  let i = at - 1;
  if (!(lines[i] ?? "").trim()) i--;
  for (; i >= 0 && /^\s*#/.test(lines[i] ?? ""); i--)
    out.unshift((lines[i] ?? "").replace(/^\s*#\s?/, ""));
  return out.join(" ").trim();
}

/** `wren-portal` → `portal` */
const short = (repo: string, name: string) =>
  name.startsWith(`${repo}-`) ? name.slice(repo.length + 1) : name;

async function files(root: string, globs: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  if (!globs.length) return out;
  for await (const f of glob([...globs], { cwd: root }))
    if (!f.includes("node_modules")) out.push(f);
  return out.sort();
}

async function pkgDescription(root: string, dir: string): Promise<string | undefined> {
  for (let d = dir; d && d !== "." && d !== "/"; d = dirname(d)) {
    const j = await readFile(join(root, d, "package.json"), "utf8").then(
      (t) => JSON.parse(t) as { description?: string },
      () => null,
    );
    if (j) return j.description;
  }
  return undefined;
}

async function wrangler(root: string, repo: string, globs: readonly string[]) {
  const units: Unit[] = [];
  const links: Link[] = [];
  for (const f of await files(root, globs)) {
    const text = await readFile(join(root, f), "utf8");
    const t = toml(text) as Record<string, unknown>;
    const lines = text.split("\n");
    // the comment above the `[[...]]` table that holds `binding = "<b>"`
    const why = (b: unknown) => {
      let at = lines.findIndex((l) => new RegExp(`^\\s*binding\\s*=\\s*"${String(b)}"`).test(l));
      while (at > 0 && !(lines[at] ?? "").startsWith("[")) at--;
      const c = at > 0 ? commentAbove(lines, at) : "";
      return c ? sentence(c) : undefined;
    };
    if (typeof t.name !== "string") continue;
    const key = `worker:${short(repo, t.name)}`;
    const entry = typeof t.main === "string" ? join(dirname(f), t.main) : undefined;
    units.push({
      key,
      title: t.name,
      technology: "Cloudflare Worker",
      description: await pkgDescription(root, dirname(f)),
      code: [f, ...(entry ? [entry] : [])],
      entry,
    });
    const arr = (k: string) => (Array.isArray(t[k]) ? (t[k] as Record<string, unknown>[]) : []);
    const store = (kind: string, name: unknown, technology: string, binding: unknown) => {
      if (typeof name !== "string") return;
      const s = `${kind}:${name}`;
      if (!units.some((u) => u.key === s))
        units.push({ key: s, title: name, technology, description: why(binding), code: [f] });
      links.push({ from: key, to: s, kind: "binds", title: `binding ${tick(name)}`, here: f });
    };
    for (const b of arr("d1_databases"))
      store("d1", b.database_name ?? b.binding, "Cloudflare D1", b.binding);
    for (const b of arr("kv_namespaces")) store("kv", b.binding, "Cloudflare KV", b.binding);
    for (const b of arr("r2_buckets"))
      store("r2", b.bucket_name ?? b.binding, "Cloudflare R2", b.binding);
    for (const b of arr("services"))
      if (typeof b.service === "string")
        links.push({
          from: key,
          to: `worker:${short(repo, b.service)}`,
          kind: "binds",
          title: `service ${tick(String(b.binding ?? b.service))}`,
          here: f,
        });
  }
  return { units, links };
}

/** A literal attribute; a `${var.x}` says nothing on its own. */
const lit = (v: unknown) => (typeof v === "string" && !v.includes("${") ? v : undefined);

const TF: Record<string, [kind: string, technology: (b: Record<string, unknown>) => string]> = {
  aws_lambda_function: ["lambda", (b) => ["Lambda", lit(b.runtime)].filter(Boolean).join(" ")],
  aws_instance: ["host", (b) => ["EC2", lit(b.instance_type)].filter(Boolean).join(" ")],
  aws_s3_bucket: ["s3", () => "S3 bucket"],
  aws_cloudfront_distribution: ["cdn", () => "CloudFront"],
};

type Resources = Record<string, Record<string, Record<string, unknown>[]>>;

/** Units from resources, and a `uses` link where one resource's body names another unit's. */
async function terraform(root: string, globs: readonly string[]) {
  const units: Unit[] = [];
  const refs: { from: string; body: string; file: string }[] = [];
  for (const f of await files(root, globs)) {
    const text = await readFile(join(root, f), "utf8");
    const lines = text.split("\n");
    const res = ((await hcl(basename(f), text)) as { resource?: Resources }).resource ?? {};
    for (const [type, byName] of Object.entries(res)) {
      const k = TF[type];
      if (!k) continue;
      for (const [name, [body]] of Object.entries(byName)) {
        const at = lines.findIndex((l) => l.startsWith(`resource "${type}" "${name}"`));
        const why = at >= 0 ? commentAbove(lines, at) : "";
        const key = `${k[0]}:${name}`;
        units.push({
          key,
          title: name,
          technology: k[1](body ?? {}),
          description: why ? sentence(why) : undefined,
          code: [f],
        });
        refs.push({ from: key, body: JSON.stringify(body ?? {}), file: f });
      }
    }
  }
  const links: Link[] = [];
  for (const r of refs)
    for (const m of r.body.matchAll(/\b(aws_[a-z0-9_]+)\.([a-z0-9_]+)\b/g)) {
      const k = TF[m[1] as string];
      if (k)
        links.push({
          from: r.from,
          to: `${k[0]}:${m[2]}`,
          kind: "uses",
          title: tick(m[0]),
          here: r.file,
        });
    }
  return { units, links };
}

const hostOf = (hosts: Readonly<Record<string, string>>, f: string) =>
  Object.entries(hosts).find(([g]) => matchesGlob(f, g))?.[1];

/** One unit per compose service; the comment above its key is the one-liner. */
async function compose(
  root: string,
  globs: readonly string[],
  hosts: Readonly<Record<string, string>>,
) {
  const units: Unit[] = [];
  for (const f of await files(root, globs)) {
    const services = parseDocument(await readFile(join(root, f), "utf8")).get("services");
    if (!isMap(services)) continue;
    for (const [i, item] of services.items.entries()) {
      if (!isScalar(item.key)) continue;
      const name = String(item.key.value);
      // yaml hangs the first key's comment on the map
      const above = item.key.commentBefore ?? (i === 0 ? services.commentBefore : undefined);
      const why = above?.replace(/^\s*/gm, "").replace(/\n/g, " ").trim();
      const image = isMap(item.value) ? item.value.get("image") : undefined;
      units.push({
        // folder prefix: two compose files may both run `caddy`
        key: `container:${basename(dirname(f))}-${name}`,
        title: name,
        technology: typeof image === "string" ? image.replace(/@sha256:.*/, "") : "container",
        description: why ? sentence(why) : undefined,
        code: [f],
        host: hostOf(hosts, f),
      });
    }
  }
  return units;
}

const TAG = /^\s*(?:#|\/\/)\s*@unit\s+(?:([a-z0-9]+):)?([a-z0-9][a-z0-9_-]*)\s*:\s*(.+)$/;

/** `# @unit [kind:]name: one line`. A file that starts a process and has no tag is listed. */
async function tagged(
  root: string,
  globs: readonly string[],
  hosts: Readonly<Record<string, string>>,
) {
  const units: Unit[] = [];
  const untagged: string[] = [];
  for (const f of await files(root, globs)) {
    const text = await readFile(join(root, f), "utf8");
    let n = 0;
    for (const line of text.split("\n")) {
      const m = line.match(TAG);
      if (!m?.[2] || !m[3]) continue;
      n++;
      const kind = m[1] ?? "container";
      units.push({
        key: `${kind}:${m[2]}`,
        title: m[2],
        technology: kind === "container" ? "container" : undefined,
        description: m[3].trim(),
        code: [f],
        host: kind === "host" ? undefined : hostOf(hosts, f),
      });
    }
    if (!n && /docker run|ExecStart=/.test(text)) untagged.push(f);
  }
  return { units, untagged };
}

/** File node id ↔ repo path, from the imports graph's package dirs. */
const IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"'.][^"']*)["']/gm;

export interface Facts {
  /** Env var → target: a unit key, repo or vendor. */
  env: Readonly<Record<string, string>>;
  /** Settings key → env var: `cacheUrl` counts as `WREN_CACHE_URL`. */
  aliases: Readonly<Record<string, string>>;
  /** Import specifier (or its scope prefix) → target. */
  imports: Readonly<Record<string, string>>;
}

/** Route → target for each route package the import map names. */
export function routeLinks(routes: Graph | null, imports: Facts["imports"]): Link[] {
  const prefixes = Object.entries(imports).sort((a, b) => b[0].length - a[0].length);
  const out: Link[] = [];
  for (const r of routes?.nodes ?? [])
    for (const p of (r.attrs?.npm as string[] | undefined) ?? []) {
      const hit = prefixes.find(([k]) => p === k || p.startsWith(k.endsWith("/") ? k : `${k}/`));
      if (hit) out.push({ from: r.id, to: hit[1], kind: "uses", title: `npm ${tick(p)}` });
    }
  return out;
}

/** Links from each unit with an entry to what its bundled files name. */
export function factLinks(
  units: readonly Unit[],
  imports: Graph,
  text: (path: string) => string,
  facts: Facts,
  /** Paths to leave out: the settings file names every env var. */
  skip: ReadonlySet<string> = new Set(),
): Link[] {
  const { pathOf, idOf } = paths(imports);
  const bundle = reach(imports);
  const envs = Object.entries(facts.env).map(([env, to]) => {
    const alias = Object.entries(facts.aliases).find(([, v]) => v === env)?.[0];
    return { env, to, re: new RegExp(`\\b${env}\\b${alias ? `|\\b${alias}\\b` : ""}`) };
  });
  const prefixes = Object.entries(facts.imports).sort((a, b) => b[0].length - a[0].length);
  const out: Link[] = [];
  for (const u of units) {
    const id = u.entry && idOf.get(u.entry);
    if (!id) continue;
    for (const f of [...bundle(id)].sort()) {
      const path = pathOf.get(f);
      if (!path || skip.has(path)) continue;
      const src = text(path);
      for (const { env, to, re } of envs)
        if (re.test(src))
          out.push({ from: u.key, to, kind: "calls", title: tick(env), here: path });
      for (const m of src.matchAll(IMPORT)) {
        const spec = m[1] as string;
        const hit = prefixes.find(
          ([p]) => spec === p || spec.startsWith(p.endsWith("/") ? p : `${p}/`),
        );
        if (hit) out.push({ from: u.key, to: hit[1], kind: "uses", title: tick(spec), here: path });
      }
    }
  }
  return out;
}

/** Restate → each unit whose bundle holds a file that defines a service. */
export function restateLinks(
  units: readonly Unit[],
  imports: Graph,
  routes: Graph | null,
  restate: string,
): Link[] {
  const { idOf } = paths(imports);
  const bundle = reach(imports);
  const defined = (routes?.nodes ?? []).flatMap((n) => {
    const id = n.role === "service" ? idOf.get(String(n.attrs?.file)) : undefined;
    return id ? [id] : [];
  });
  const out: Link[] = [];
  for (const u of units) {
    const id = u.entry && idOf.get(u.entry);
    if (!id || u.key === restate) continue;
    const b = bundle(id);
    const n = defined.filter((f) => b.has(f)).length;
    if (n)
      out.push({
        from: restate,
        to: u.key,
        kind: "invokes",
        title: `${n} services`,
        here: u.entry,
      });
  }
  return out;
}

export interface Repo {
  id: string;
  description?: string | undefined;
  /** npm names of its packages. */
  names: string[];
  /** package.json path (from the subject root) → runtime deps. */
  deps: Record<string, string[]>;
}

async function repoOf(
  root: string,
  id: string,
  dir: string,
  globs: readonly string[],
): Promise<Repo> {
  const deps: Record<string, string[]> = {};
  const names: string[] = [];
  let description: string | undefined;
  for (const f of await files(resolve(root, dir), [
    "package.json",
    ...globs.map((g) => `${g}/package.json`),
  ])) {
    const j = JSON.parse(await readFile(resolve(root, dir, f), "utf8")) as {
      name?: string;
      description?: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    if (j.name) names.push(j.name);
    if (f === "package.json") description = j.description;
    deps[join(dir, f)] = Object.keys({ ...j.dependencies, ...j.peerDependencies });
  }
  return { id, description, names, deps };
}

/** A package dep from one repo on another's package. */
export function repoLinks(repos: readonly Repo[]): Link[] {
  const owner = new Map<string, string>();
  for (const r of repos) for (const n of r.names) owner.set(n, r.id);
  const out: Link[] = [];
  for (const r of repos)
    for (const [file, ds] of Object.entries(r.deps))
      for (const d of ds) {
        const to = owner.get(d);
        if (to && to !== r.id)
          out.push({ from: r.id, to, kind: "uses", title: `npm ${tick(d)}`, here: file });
      }
  return out;
}

export interface Residue {
  vendors: Readonly<Record<string, { title: string; description?: string | undefined }>>;
  describe: Readonly<Record<string, string>>;
}

/** Units, repos and links into one graph. A link to an unknown end is dropped and listed. */
export function assemble(
  repo: string,
  units: readonly Unit[],
  repos: readonly Repo[],
  links: readonly Link[],
  residue: Residue,
): { graph: Graph; loose: string[] } {
  const unitId = (k: string) => `system:${repo}.${k}`;
  const known = new Map<string, string>([[repo, `system:${repo}`]]);
  for (const u of units) known.set(u.key, unitId(u.key));
  for (const r of repos) known.set(r.id, `system:${r.id}`);
  for (const v of Object.keys(residue.vendors)) known.set(v, `system:${v}`);
  const top = (id: string, kind: string, title: string, description?: string): Node => {
    const d = residue.describe[id] ?? description;
    return {
      id: `system:${id}`,
      role: "system",
      group: id,
      attrs: { kind, title, ...(d ? { description: d } : {}) },
    };
  };
  const nodes: Node[] = repos.map((r) => top(r.id, "repo", r.id, r.description));
  for (const [id, v] of Object.entries(residue.vendors))
    nodes.push(top(id, "vendor", v.title, v.description));
  for (const u of units) {
    const attrs: Record<string, Attr> = {
      kind: u.key.split(":")[0] ?? "part",
      title: u.title,
      code: u.code,
    };
    const d = residue.describe[u.key] ?? u.description;
    if (d) attrs.description = d;
    if (u.technology) attrs.technology = u.technology;
    const host = u.host && known.has(u.host) && u.host !== u.key ? unitId(u.host) : undefined;
    nodes.push({
      id: unitId(u.key),
      role: "part",
      parent: host ?? `system:${repo}`,
      group: repo,
      attrs,
    });
  }
  const loose = new Set<string>();
  const pairs = new Map<string, { e: Edge; title: Set<string>; here: Set<string> }>();
  for (const l of links) {
    const from = known.get(l.from) ?? (l.from.startsWith("route:") ? l.from : undefined);
    const to = known.get(l.to);
    if (!from || !to) {
      loose.add(`${l.from} → ${l.to} (${l.title})`);
      continue;
    }
    if (from === to) continue;
    const k = `${from}\0${l.kind}\0${to}`;
    const p = pairs.get(k) ?? { e: { from, to, kind: l.kind }, title: new Set(), here: new Set() };
    p.title.add(l.title);
    if (l.here) p.here.add(l.here);
    pairs.set(k, p);
  }
  const edges = [...pairs.values()].map(({ e, title, here }) => ({
    ...e,
    attrs: { title: [...title].sort(), here: [...here].sort() },
  }));
  return { graph: { layer: "systems", nodes, edges }, loose: [...loose].sort() };
}

/** Settings key → env var, from the settings file's own map. */
async function aliasesOf(root: string, cfg: SystemsConfig): Promise<Record<string, string>> {
  if (!cfg.settings) return {};
  const src = await readFile(join(root, cfg.settings.file), "utf8");
  const out: Record<string, string> = {};
  for (const m of src.matchAll(new RegExp(cfg.settings.pattern, "g")))
    if (m[1] && m[2]) out[m[1]] = m[2];
  return out;
}

async function extract(ctx: LayerContext): Promise<Graph> {
  const cfg = ctx.config.layers.systems;
  if (!cfg) throw new Error("systems: no `layers.systems` in kestrel.json");
  const imports = await ctx.prior("imports");
  if (!imports) throw new Error("systems: no imports graph; run `kestrel gen imports` first");
  const repo = basename(ctx.root);
  const w = await wrangler(ctx.root, repo, cfg.wrangler);
  const t = await tagged(ctx.root, cfg.tags, cfg.hosts);
  const tf = await terraform(ctx.root, cfg.terraform);
  const units = [
    ...w.units,
    ...tf.units,
    ...(await compose(ctx.root, cfg.compose, cfg.hosts)),
    ...t.units,
  ];
  for (const u of units) {
    const entry = cfg.entries[u.key];
    if (!entry) continue;
    u.entry = entry;
    if (!u.code.includes(entry)) u.code.push(entry);
    u.description ??= await pkgDescription(ctx.root, dirname(entry));
  }
  const repos = await Promise.all([
    repoOf(ctx.root, repo, ".", cfg.packages),
    ...Object.entries(cfg.repos).map(([id, dir]) => repoOf(ctx.root, id, dir, cfg.packages)),
  ]);
  const toRepo: Record<string, string> = {};
  for (const r of repos) if (r.id !== repo) for (const n of r.names) toRepo[n] = r.id;
  const { pathOf } = paths(imports);
  const text = new Map<string, string>();
  await Promise.all(
    [...pathOf.values()].map(async (p) =>
      text.set(p, await readFile(join(ctx.root, p), "utf8").catch(() => "")),
    ),
  );
  const routes = await ctx.prior("routes");
  const facts = {
    env: cfg.env,
    aliases: await aliasesOf(ctx.root, cfg),
    imports: { ...toRepo, ...cfg.imports },
  };
  const links = [
    ...w.links,
    ...tf.links,
    ...factLinks(
      units,
      imports,
      (p) => text.get(p) ?? "",
      facts,
      new Set(cfg.settings ? [cfg.settings.file] : []),
    ),
    ...(cfg.restate ? restateLinks(units, imports, routes, cfg.restate) : []),
    ...routeLinks(routes, facts.imports),
    ...repoLinks(repos),
  ];
  const { graph, loose } = assemble(repo, units, repos, links, cfg);
  for (const f of t.untagged)
    console.warn(`systems: ${f} starts a process and has no \`# @unit name: one line\``);
  for (const l of loose) console.warn(`systems: link to nothing known: ${l}`);
  for (const n of graph.nodes)
    if (!n.attrs?.description) console.warn(`systems: ${n.id} has no one-liner`);
  return graph;
}

/** Code paths a node or edge names that are not on disk: `<where>: <path>`. */
export async function seams(root: string, g: Graph): Promise<string[]> {
  const named: [string, string][] = [];
  const list = (v: Attr | undefined) => (Array.isArray(v) ? (v as readonly string[]) : []);
  for (const n of g.nodes) for (const p of list(n.attrs?.code)) named.push([n.id, p]);
  for (const e of g.edges)
    for (const p of list(e.attrs?.here)) named.push([`${e.from} → ${e.to}`, p]);
  const gone: string[] = [];
  for (const [where, p] of named)
    if (
      !(await access(resolve(root, p)).then(
        () => true,
        () => false,
      ))
    )
      gone.push(`${where}: ${p}`);
  return gone;
}

/** One system: what it holds, and each link with the code it comes from. */
function page(g: Graph): Record<string, string> {
  const group = g.nodes[0]?.group;
  if (!group) return {};
  const top = g.nodes.find((n) => n.role === "system");
  const L = [`# ${top?.attrs?.title ?? group}: system`, ""];
  if (top?.attrs?.description) L.push(String(top.attrs.description), "");
  const code = (x: Attr | undefined) =>
    (Array.isArray(x) ? (x as readonly string[]) : []).map(tick).join(", ");
  const inside = g.nodes.filter((n) => n.role === "part");
  if (inside.length) {
    L.push("## Inside", "");
    for (const n of inside) {
      const d = n.attrs?.description ? `: ${n.attrs.description}` : "";
      L.push(`- **${n.attrs?.title}** (${n.attrs?.technology ?? n.attrs?.kind})${d}`);
    }
    L.push("");
  }
  if (g.edges.length) {
    L.push("## Links", "");
    for (const e of g.edges) {
      const titles = (e.attrs?.title as readonly string[] | undefined) ?? [];
      const bare = (id: string) => id.replace(/^system:/, "");
      L.push(`- ${bare(e.from)} ${e.kind} ${bare(e.to)}: ${titles.join(", ")}`);
      if (code(e.attrs?.here)) L.push(`  - in ${code(e.attrs?.here)}`);
    }
    L.push("");
  }
  return { [`${group}.md`]: L.join("\n") };
}

export const systems: Layer = {
  id: "systems",
  async sections({ root, config, prior }) {
    const cfg = config.layers.systems;
    const imports = await prior("imports");
    if (!cfg || !imports) return null;
    // the bundled files' text, the deploy files, every repo's package.json; routes by content
    const { pathOf } = paths(imports);
    const pkgs = [".", ...Object.values(cfg.repos)].flatMap((d) => [
      join(d, "package.json"),
      ...cfg.packages.map((g) => join(d, g, "package.json")),
    ]);
    const globs = [
      ...cfg.wrangler,
      ...cfg.terraform,
      ...cfg.compose,
      ...cfg.tags,
      ...Object.keys(cfg.hosts),
      ...pkgs,
    ];
    const files = new Set([...(await filesOf(root, globs)), ...pathOf.values()]);
    if (cfg.settings) files.add(cfg.settings.file);
    const routes = await prior("routes");
    return [
      {
        group: WHOLE,
        files: [...files].sort(),
        names: [JSON.stringify(imports.edges), routes ? JSON.stringify(routes) : ""],
      },
    ];
  },
  extract,
  render: page,
};
