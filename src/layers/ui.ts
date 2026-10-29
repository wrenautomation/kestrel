/**
 * The screens and the stories, two halves of one question: what a person sees, and where each
 * part of it is drawn and shown alone.
 * Screens come from the repo's own dump command (`dump` in kestrel.json, run in the repo root):
 * a router built from data reads wrong statically, so the repo prints what it registers. It
 * prints `{areas: {<who>: [{id, label, apps}]}, apps: [{id, name, blurb, file, pages: [{id,
 * label, about?, group?, hidden?, template, record?, file?}]}], home?, inputs?}`, paths from the
 * repo root. `home`: apps of that shape at the root address `/`, one per workspace.
 * `inputs`: every file the dump read. Kept in the cache, they key the next gen, so the layer
 * reruns only when one changes; `inputs` in kestrel.json overrides them.
 * Stories are read statically from CSF files: the default export's `title` and `id`, and the
 * relative imports, which are the parts it shows (mocks and fixtures are not parts).
 * Nodes: `app` (`ui:<app>`), `screen` (`ui:<app>/<page>`, parent its app), `story`
 * (`story:<id>`). A screen's `file` and a story's `shows` are repo paths, which the imports layer
 * already links to the parts. Groups: one per app, `_stories` for the stories.
 * Edges `calls`: screen → route. The dump's `api` maps a client path's first part to the service
 * it reaches (`accounts` → `AccountsConsole`). A literal `<fn>("accounts/list")` (fns in
 * `layers.ui.calls`) in a file the screen's file reaches is a call; `at` holds the files, `path`
 * the literal (the key a story's call log names). Only
 * screens drawn by their own file (`hand`): a template screen's calls are its template's. Shell:
 * a file reached by over a quarter of the screen files (the api client, the frame) calls for every
 * screen, so its calls are left out. Known gap: a hook that several screens share hides too; the
 * story's runtime call log will give the exact list. Screen attrs for literals no route matches:
 * `missing` (its service has no such route), `host` (its first part names no service: the host
 * answers it, or a typo).
 * Edges `reads`: record screen → table. Each `<records>({id, view, activity?: {view}})` call in the
 * packages (`layers.ui.records`) names a kind's views; the checker reads a const id. A view with
 * no schema is `public`. A kind's `rows` function: the tables it reaches (./reach.ts); what it
 * reaches outside, screen attrs `hosts` and `npm`. A key in a spread (`...FORM_BASE`) is read by
 * the type.
 * Edges `renders`: story → screen (`pageEdges`), from `export const X = <pages>("/path")`.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { glob, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { storyNameFromExport, toId } from "@storybook/csf";
import { type Project, SyntaxKind, Node as TsNode } from "ts-morph";
import { z } from "zod";
import { filesOf, WHOLE } from "../cache.js";
import type { Attr, Edge, Graph, Node } from "../graph.js";
import { paths, reach } from "./files.js";
import type { Layer, LayerContext } from "./layer.js";
import { reader } from "./reach.js";
import { packages, SOURCE, tsProject } from "./workspace.js";

const run = promisify(execFile);

/** The files the last dump read (see the header). */
const readOf = (root: string) => join(root, "node_modules/.cache/kestrel/ui.inputs.json");

const App = z.object({
  id: z.string(),
  name: z.string(),
  blurb: z.string().optional(),
  file: z.string().optional(),
  /** The name the app is exported as: it names an app whose id another app shares. */
  export: z.string().optional(),
  /** `team`: Wren's own workspace only. Else a client's. */
  audience: z.string().optional(),
  parked: z.boolean().optional(),
  menu: z.boolean().optional(),
  pages: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      about: z.string().optional(),
      group: z.string().optional(),
      hidden: z.boolean().optional(),
      template: z.string(),
      record: z.string().optional(),
      file: z.string().optional(),
    }),
  ),
});

const Dump = z.object({
  areas: z.record(
    z.string(),
    z.array(z.object({ id: z.string(), label: z.string(), apps: z.array(z.string()) })),
  ),
  apps: z.array(App),
  /** What the root address `/` draws: an app per workspace, its id unique, path `/`. */
  home: z.array(App).optional(),
  inputs: z.array(z.string()).optional(),
  /** A client path's first part → the service it reaches. */
  api: z.record(z.string(), z.string()).optional(),
});
export type Dump = z.infer<typeof Dump>;

export interface Story {
  /** Repo-relative story file. */
  file: string;
  id: string;
  title: string;
  /** Repo-relative files it imports by a relative path. */
  shows: string[];
  /** Page stories: the Storybook id, the address each opens, and the team workspace or not. */
  pages?: { id: string; at: string; team?: true }[];
}

/** A file reached by more than this share of the screen files is shell (see the header). */
const SHELL = 0.25;

export interface CallsInput {
  screens: readonly { id: string; file: string }[];
  /** Repo paths a file reaches at run time, itself included; undefined when the graph lacks it. */
  reach: (file: string) => ReadonlySet<string> | undefined;
  text: (file: string) => string;
  api: Readonly<Record<string, string>>;
  routes: Graph | null;
  fns: readonly string[];
}

/** Screen → route edges and each screen's unmatched literals (see the header). */
export function screenCalls(x: CallsInput): {
  edges: Edge[];
  lost: Map<string, { missing?: string[]; host?: string[] }>;
} {
  const route = new Map<string, string>();
  for (const n of x.routes?.nodes ?? []) {
    if (n.role !== "route" || !n.parent) continue;
    // `service:Name@path` names a second service with one name: the plain one wins.
    const svc = n.parent.slice("service:".length);
    const key = `${svc.replace(/@.*$/, "")}/${n.id.slice(`route:${svc}/`.length)}`;
    if (!route.has(key) || !n.parent.includes("@")) route.set(key, n.id);
  }
  const fns = x.fns.map((f) => f.replace(/[$]/g, "\\$")).join("|");
  const lit = new RegExp(
    `\\b(?:${fns})\\s*(?:<[^();]*?>)?\\(\\s*["'\`]([a-z][\\w-]*/[\\w-]+)["'\`]`,
    "g",
  );
  const lits = new Map<string, string[]>();
  const litsOf = (f: string) => {
    let got = lits.get(f);
    if (!got) {
      got = [...new Set([...x.text(f).matchAll(lit)].map((m) => m[1] as string))];
      lits.set(f, got);
    }
    return got;
  };
  const reached = new Map<string, ReadonlySet<string>>();
  for (const s of x.screens) {
    const r = reached.has(s.file) ? undefined : x.reach(s.file);
    if (r) reached.set(s.file, r);
  }
  const count = new Map<string, number>();
  for (const r of reached.values()) for (const f of r) count.set(f, (count.get(f) ?? 0) + 1);
  const shell = (f: string) => (count.get(f) ?? 0) > reached.size * SHELL;
  const edges: Edge[] = [];
  const lost = new Map<string, { missing?: string[]; host?: string[] }>();
  for (const s of x.screens) {
    const r = reached.get(s.file);
    if (!r) continue;
    const at = new Map<string, Set<string>>();
    for (const f of r) {
      if (f !== s.file && shell(f)) continue;
      for (const l of litsOf(f)) at.set(l, (at.get(l) ?? new Set()).add(f));
    }
    const missing: string[] = [];
    const host: string[] = [];
    for (const [l, files] of [...at].sort((a, b) => a[0].localeCompare(b[0]))) {
      const [head = "", ...rest] = l.split("/");
      const svc = x.api[head];
      const to = svc ? route.get(`${svc}/${rest.join("/")}`) : undefined;
      if (to)
        edges.push({ from: s.id, to, kind: "calls", attrs: { at: [...files].sort(), path: l } });
      else (svc ? missing : host).push(l);
    }
    if (missing.length || host.length)
      lost.set(s.id, { ...(missing.length ? { missing } : {}), ...(host.length ? { host } : {}) });
  }
  return { edges, lost };
}

const set = (o: Record<string, Attr>, k: string, v: Attr | undefined) => {
  if (v !== undefined && v !== "" && v !== false) o[k] = v;
};

export function fromDump(
  d: Dump,
  stories: Story[],
  calls?: Omit<CallsInput, "screens" | "api">,
  /** Page stories pick a workspace (`layers.ui.team`). */
  split = false,
): Graph {
  const nodes: Node[] = [];
  // Each app's place in each sidebar: `team: Marketing`. The team sidebar holds team apps only,
  // so of two apps with one id each gets its own workspace's place.
  const areas = new Map<string, { team: boolean; at: string }[]>();
  for (const [who, list] of Object.entries(d.areas))
    for (const a of list)
      for (const app of a.apps)
        areas.set(app, [
          ...(areas.get(app) ?? []),
          { team: who === "team", at: `${who}: ${a.label}` },
        ]);
  // Two apps can share an id (one per workspace): each of them goes by its export name, or `<id>~<n>`.
  const count = new Map<string, number>();
  for (const app of d.apps) count.set(app.id, (count.get(app.id) ?? 0) + 1);
  const seen = new Map<string, number>();
  const root = new Set(d.home ?? []);
  for (const app of [...d.apps, ...(d.home ?? [])]) {
    const n = (seen.get(app.id) ?? 0) + 1;
    seen.set(app.id, n);
    const key =
      root.has(app) || count.get(app.id) === 1 ? app.id : (app.export ?? `${app.id}~${n}`);
    const id = `ui:${key}`;
    const team = app.audience === "team";
    const attrs: Record<string, Attr> = { name: app.name, workspace: team ? "wren" : "client" };
    set(attrs, "blurb", app.blurb);
    set(attrs, "file", app.file);
    const at = (areas.get(app.id) ?? []).filter((a) => a.team === team).map((a) => a.at);
    set(attrs, "areas", at.length ? at : undefined);
    set(attrs, "parked", app.parked);
    set(attrs, "menu", app.menu);
    set(attrs, "path", root.has(app) ? "/" : `/${app.id}`);
    nodes.push({ id, role: "app", group: key, attrs });
    for (const [i, p] of app.pages.entries()) {
      // Ids sort; the tab order is kept here.
      const a: Record<string, Attr> = { label: p.label, template: p.template, order: i };
      set(a, "about", p.about);
      set(a, "group", p.group);
      set(a, "hidden", p.hidden);
      set(a, "record", p.record);
      set(a, "file", p.file);
      nodes.push({ id: `${id}/${p.id}`, role: "screen", parent: id, group: key, attrs: a });
    }
  }
  for (const s of stories)
    nodes.push({
      id: `story:${s.id}`,
      role: "story",
      group: "_stories",
      attrs: { title: s.title, file: s.file, shows: s.shows },
    });
  const shown = pageEdges(nodes, stories, split);
  if (!calls || !d.api) return { layer: "ui", nodes, edges: shown };
  const screens = nodes.flatMap((n) =>
    n.role === "screen" && n.attrs?.template === "hand" && typeof n.attrs.file === "string"
      ? [{ id: n.id, file: n.attrs.file }]
      : [],
  );
  const { edges, lost } = screenCalls({ ...calls, screens, api: d.api });
  for (const n of nodes) {
    const l = lost.get(n.id);
    if (l) n.attrs = { ...n.attrs, ...l };
  }
  return { layer: "ui", nodes, edges: [...shown, ...edges] };
}

/**
 * Story → screen edges `renders`, attr `stories`: the page stories that open it. A screen's
 * address is its app's `path` and its page id, in its app's workspace (two apps can share a
 * path, one per workspace); a story's address can go under it (a record). An app's own address
 * is its first page. Without `split`, the workspace is not read and the first app wins.
 */
export function pageEdges(
  nodes: readonly Node[],
  stories: readonly Story[],
  split = false,
): Edge[] {
  const app = new Map<string, { path: string; ws: string }>();
  for (const n of nodes)
    if (n.role === "app" && typeof n.attrs?.path === "string")
      app.set(n.id, { path: n.attrs.path, ws: split ? String(n.attrs.workspace) : "" });
  const screen = new Map<string, string>();
  const first = new Map<string, { id: string; order: number }>();
  for (const n of nodes) {
    const a = n.role === "screen" && n.parent ? app.get(n.parent) : undefined;
    if (!a || !n.parent) continue;
    const k = `${a.ws}\0${a.path.slice(1)}/${n.id.slice(n.parent.length + 1)}`;
    if (!screen.has(k)) screen.set(k, n.id);
    const order = Number(n.attrs?.order ?? 0);
    const had = first.get(n.parent);
    if (!had || order < had.order) first.set(n.parent, { id: n.id, order });
  }
  for (const [id, f] of first) {
    const a = app.get(id) as { path: string; ws: string };
    const k = `${a.ws}\0${a.path.slice(1)}`;
    if (!screen.has(k)) screen.set(k, f.id);
  }
  const edges: Edge[] = [];
  for (const s of stories) {
    const to = new Map<string, string[]>();
    for (const p of s.pages ?? []) {
      const parts = p.at
        .replace(/[?#].*$/, "")
        .split("/")
        .filter(Boolean);
      const ws = split ? (p.team ? "wren" : "client") : "";
      // `/` is the root app's own address only, never a fallback
      for (let i = parts.length; i >= (parts.length ? 1 : 0); i--) {
        const hit = screen.get(`${ws}\0${parts.slice(0, i).join("/")}`);
        if (!hit) continue;
        to.set(hit, [...(to.get(hit) ?? []), p.id]);
        break;
      }
    }
    for (const [id, ids] of to)
      edges.push({ from: `story:${s.id}`, to: id, kind: "renders", attrs: { stories: ids } });
  }
  return edges;
}

/** The repo source globs records are read from: the routes layer's packages. */
async function sourceGlobs(root: string, globs: string[] | undefined) {
  const pkgs = await packages(root, globs ?? ["packages/*", "apps/*"]);
  return {
    pkgs,
    globs: pkgs.flatMap((p) => SOURCE.map((g) => (g.startsWith("!") ? g : `${p.dir}/${g}`))),
  };
}

/** Record kind → the tables it reads (see the header). */
export function recordTables(
  project: Project,
  fn: string,
  tables: ReadonlySet<string>,
  /** Filled per kind: what its rows reach outside (an export API's host, a vendor package). */
  outside?: Map<string, { hosts: string[]; npm: string[] }>,
): Map<string, string[]> {
  const read = reader(project, tables);
  const out = new Map<string, string[]>();
  const at = (o: TsNode | undefined, key: string): TsNode | undefined => {
    if (!o) return undefined;
    // a key not written here comes in a spread (`...FORM_BASE`): its declaration, by the type
    const p =
      (TsNode.isObjectLiteralExpression(o) ? o.getProperty(key) : undefined) ??
      o.getType().getProperty(key)?.getDeclarations()[0];
    if (p && TsNode.isPropertyAssignment(p)) return p.getInitializerOrThrow();
    if (p && TsNode.isShorthandPropertyAssignment(p)) return p.getNameNode();
    return p && TsNode.isMethodDeclaration(p) ? p : undefined;
  };
  const view = (v: TsNode | undefined) => {
    const t = v?.getType();
    if (!t?.isStringLiteral()) return [];
    const name = String(t.getLiteralValue());
    const id = `table:${name.includes(".") ? name : `public.${name}`}`;
    return tables.has(id) ? [id] : [];
  };
  for (const f of project.getSourceFiles()) {
    if (!f.getFullText().includes(`${fn}(`)) continue;
    for (const c of f.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (c.getExpression().getText() !== fn) continue;
      const arg = c.getArguments()[0];
      const id = at(arg, "id")?.getType();
      if (!id?.isStringLiteral()) continue;
      const rows = at(arg, "rows");
      const r = rows ? read(rows) : undefined;
      const hit = new Set([
        ...view(at(arg, "view")),
        ...view(at(at(arg, "activity"), "view")),
        ...(r?.tables.keys() ?? []),
      ]);
      const kind = String(id.getLiteralValue());
      if (hit.size) out.set(kind, [...hit].sort());
      if (outside && (r?.hosts.size || r?.npm.size))
        outside.set(kind, { hosts: [...r.hosts].sort(), npm: [...r.npm].sort() });
    }
  }
  return out;
}

/** Record screen → table edges. */
export function recordReads(nodes: readonly Node[], kinds: Map<string, string[]>): Edge[] {
  return nodes.flatMap((n) => {
    const kind = n.role === "screen" ? n.attrs?.record : undefined;
    const to = typeof kind === "string" ? (kinds.get(kind) ?? []) : [];
    return to.map((t) => ({ from: n.id, to: t, kind: "reads" }));
  });
}

/**
 * One CSF file: its meta's `title` and `id` (the file name when it has none), its relative
 * imports, and with `page` the exports made by `<page>("/path")`.
 */
export function readStory(
  root: string,
  file: string,
  text: string,
  page?: string,
  team?: RegExp,
): Story {
  // `export default meta;` names a const above it: read the meta from there.
  const named = /export default\s+(\w+)\s*;/.exec(text)?.[1];
  const decl = named ? text.search(new RegExp(`\\b(?:const|let|var)\\s+${named}\\b`)) : -1;
  const meta = text.slice(decl >= 0 ? decl : text.search(/export default\b/));
  const title = /\btitle:\s*["'`]([^"'`]+)["'`]/.exec(meta)?.[1];
  const id = /\bid:\s*["'`]([^"'`]+)["'`]/.exec(meta)?.[1];
  const shows = new Set<string>();
  for (const m of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["'](\.[^"']+)["']/gm)) {
    const rel = (m[1] as string).replace(/\.js$/, "");
    const at = join(dirname(file), rel);
    const hit = ["", ".tsx", ".ts", "/index.tsx", "/index.ts"]
      .map((x) => at + x)
      .find((p) => /\.tsx?$/.test(p) && existsSync(join(root, p)));
    if (hit && !/[./](fixtures?|stories|mocks?)\b/.test(hit)) shows.add(hit);
  }
  const name = file.replace(/^.*\//, "").replace(/\.stories\.tsx?$/, "");
  const kind = id ?? title ?? name;
  const pages = page
    ? [
        ...text.matchAll(
          new RegExp(
            `^export const (\\w+)\\s*(?::[^=]+)?=\\s*${page}\\(\\s*["'\`]([^"'\`]+)`,
            "gm",
          ),
        ),
      ].map((m) => {
        // the call runs to the next export
        const rest = text.slice(m.index);
        const end = rest.slice(1).search(/^export /m);
        const call = end < 0 ? rest : rest.slice(0, end + 1);
        return {
          id: toId(kind, storyNameFromExport(m[1] as string)),
          at: m[2] as string,
          ...(team?.test(call) ? { team: true as const } : {}),
        };
      })
    : [];
  return {
    file,
    id: id ?? name,
    title: title ?? name,
    shows: [...shows].sort(),
    ...(pages.length ? { pages } : {}),
  };
}

async function extract(ctx: LayerContext): Promise<Graph> {
  const cfg = ctx.config.layers.ui;
  if (!cfg) throw new Error("ui: no `layers.ui` in kestrel.json");
  const { stdout } = await run("sh", ["-c", cfg.dump], {
    cwd: ctx.root,
    env: ctx.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const dump = Dump.parse(JSON.parse(stdout));
  if (dump.inputs) {
    await mkdir(dirname(readOf(ctx.root)), { recursive: true });
    await writeFile(readOf(ctx.root), JSON.stringify(dump.inputs));
  } else await rm(readOf(ctx.root), { force: true });
  const stories: Story[] = [];
  const team = cfg.team ? new RegExp(cfg.team) : undefined;
  for await (const f of glob(cfg.stories, { cwd: ctx.root })) {
    if (f.includes("node_modules")) continue;
    const file = relative(ctx.root, join(ctx.root, f));
    stories.push(
      readStory(ctx.root, file, await readFile(join(ctx.root, file), "utf8"), cfg.pages, team),
    );
  }
  const imports = await ctx.prior("imports");
  const g = imports
    ? await withCalls(ctx, dump, stories, imports)
    : fromDump(dump, stories, undefined, Boolean(cfg.team));
  if (!cfg.records) return g;
  const schema = await ctx.prior("schema");
  const tables = new Set((schema?.nodes ?? []).filter((n) => n.role === "table").map((n) => n.id));
  const { pkgs } = await sourceGlobs(ctx.root, ctx.config.layers.routes?.packages);
  const outside = new Map<string, { hosts: string[]; npm: string[] }>();
  const kinds = recordTables(tsProject(ctx.root, pkgs), cfg.records, tables, outside);
  const edges = [...g.edges, ...recordReads(g.nodes, kinds)];
  for (const n of g.nodes) {
    const o = n.role === "screen" ? outside.get(String(n.attrs?.record)) : undefined;
    if (o?.hosts.length) n.attrs = { ...n.attrs, hosts: o.hosts };
    if (o?.npm.length) n.attrs = { ...n.attrs, npm: o.npm };
  }
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { ...g, edges };
}

async function withCalls(ctx: LayerContext, dump: Dump, stories: Story[], imports: Graph) {
  const cfg = ctx.config.layers.ui as NonNullable<LayerContext["config"]["layers"]["ui"]>;
  const { pathOf, idOf } = paths(imports);
  const from = reach(imports);
  return fromDump(
    dump,
    stories,
    {
      reach: (file) => {
        const id = idOf.get(file);
        return id ? new Set([...from(id)].flatMap((f) => pathOf.get(f) ?? [])) : undefined;
      },
      text: (file) => {
        try {
          return readFileSync(join(ctx.root, file), "utf8");
        } catch {
          return "";
        }
      },
      routes: await ctx.prior("routes"),
      fns: cfg.calls,
    },
    Boolean(cfg.team),
  );
}

/** Source files that call the records function. */
async function recordFiles(root: string, globs: string[] | undefined, fn: string) {
  const all = await filesOf(root, (await sourceGlobs(root, globs)).globs);
  const has = await Promise.all(
    all.map(async (f) => (await readFile(join(root, f), "utf8")).includes(`${fn}(`)),
  );
  return all.filter((_, i) => has[i]);
}

export const ui: Layer = {
  id: "ui",
  async sections({ root, config, prior }) {
    const cfg = config.layers.ui;
    if (!cfg) return null;
    const read = cfg.inputs
      ? await filesOf(root, cfg.inputs)
      : await readFile(readOf(root), "utf8").then(
          (t) => JSON.parse(t) as string[],
          () => null,
        );
    if (!read) return null;
    // calls read the routes and the imports edges too; records, their files and the tables
    const [imports, routes] = [await prior("imports"), await prior("routes")];
    const schema = cfg.records ? await prior("schema") : null;
    const declared = cfg.records
      ? await recordFiles(root, config.layers.routes?.packages, cfg.records)
      : [];
    return [
      {
        group: WHOLE,
        files: [...new Set([...read, ...(await filesOf(root, cfg.stories)), ...declared])],
        names: [
          imports ? JSON.stringify(imports.edges) : "",
          routes ? JSON.stringify(routes.nodes.map((n) => n.id)) : "",
          schema ? JSON.stringify(schema.nodes.map((n) => n.id)) : "",
        ],
      },
    ];
  },
  extract,
  render: (group) => page(group),
};

/** One app: its pages in order, each with what it is for and where it is drawn. Or every story. */
function page(g: Graph): Record<string, string> {
  const group = g.nodes[0]?.group;
  if (!group) return {};
  const tick = (x: Attr | undefined) => (x ? `\`${x}\`` : "");
  if (group === "_stories") {
    const lines = ["# Stories", "", "| Story | File | Shows |", "|---|---|---|"];
    for (const n of g.nodes)
      lines.push(
        `| ${n.attrs?.title} | ${tick(n.attrs?.file)} | ${((n.attrs?.shows as readonly string[]) ?? []).map(tick).join(", ")} |`,
      );
    return { "_stories.md": `${lines.join("\n")}\n` };
  }
  const app = g.nodes.find((n) => n.role === "app");
  const lines = [`# ${app?.attrs?.name ?? group}: app, ${app?.attrs?.workspace} workspace`, ""];
  if (app?.attrs?.blurb) lines.push(String(app.attrs.blurb), "");
  const areas = app?.attrs?.areas as readonly string[] | undefined;
  if (areas?.length) lines.push(`Sidebar: ${areas.join("; ")}.`, "");
  if (app?.attrs?.file) lines.push(`Registered in ${tick(app.attrs.file)}.`, "");
  lines.push("| Page | Template | Drawn in | Calls | For |", "|---|---|---|---|---|");
  const screens = g.nodes.filter((x) => x.role === "screen");
  screens.sort((a, b) => Number(a.attrs?.order) - Number(b.attrs?.order));
  for (const n of screens) {
    const a = n.attrs ?? {};
    const tmpl = a.record ? `${a.template} of \`${a.record}\`` : String(a.template);
    const calls = [
      ...g.edges.filter((e) => e.from === n.id).map((e) => tick(e.to.slice("route:".length))),
      ...((a.missing as readonly string[]) ?? []).map((m) => `${tick(m)} (no route)`),
      ...((a.host as readonly string[]) ?? []).map((m) => `${tick(m)} (host)`),
    ];
    lines.push(
      `| ${a.label}${a.hidden ? " (link only)" : ""} | ${tmpl} | ${tick(a.file)} | ${calls.join(", ")} | ${a.about ?? ""} |`,
    );
  }
  return { [`${group}.md`]: `${lines.join("\n")}\n` };
}
