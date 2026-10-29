/**
 * Every layer's graph → one tree to zoom (repo → top folder → package → source folder → file,
 * repo → database → schema → table, repo → systems → system → part, repo → screens → app →
 * screen, and repo → patterns → pattern), with each level's lines lifted to its kids. Exports and routes are not boxes: they sit in
 * their file's detail, so a level stays a readable dependency graph. The page lays levels out.
 */
import { basename } from "node:path";
import type { Cost } from "../cost.js";
import { diff } from "../diff.js";
import { type Edge, edgeId, type Graph, type Node } from "../graph.js";
import type { Recent } from "../recent.js";
import { implied } from "./reduce.js";
import { slices } from "./slice.js";
import type {
  CardView,
  Detail,
  Drift,
  Level,
  LevelEdge,
  Link,
  Path,
  Service,
  StoryRef,
  TreeNode,
  ViewData,
} from "./types.js";

export interface ViewInput {
  root: string;
  current: Record<string, Graph | null>;
  approved: Record<string, Graph | null>;
  cards?: CardView[];
  /** Node roles that need a card (`kestrel.json` cards.require). */
  require?: readonly string[];
  /** `kestrel cost`'s stored report, when there is one. */
  cost?: Cost | null;
  /** `kestrel recent`'s stored report, when there is one. */
  recent?: Recent | null;
  storybook?: string;
}

/** Over this many boxes a layered graph is a hairball, and ELK takes seconds: a grid by fan-in. */
export const GRID_OVER = 40;

const emptyDetail = (): Detail => ({
  uses: [],
  usedBy: [],
  exports: [],
  services: [],
  indexes: [],
  seams: [],
  inferred: 0,
  exportCount: 0,
  cards: [],
});

export async function buildView(input: ViewInput): Promise<ViewData> {
  const imports = input.current.imports;
  const repoNode = imports?.nodes.find((n) => n.role === "repo");
  const repo = repoNode?.id ?? `repo:${basename(input.root)}`;
  const nodes: Record<string, TreeNode> = {
    [repo]: { id: repo, label: repo.slice("repo:".length), role: "repo", kids: [], files: 0 },
  };
  const details: Record<string, Detail> = {};
  const detail = (id: string) => {
    details[id] ??= emptyDetail();
    return details[id];
  };
  const add = (n: TreeNode) => {
    nodes[n.id] = n;
    if (n.parent) nodes[n.parent]?.kids.push(n.id);
    return n;
  };

  // Packages, under their top folder when the repo has more than one (apps/, packages/).
  const pkgs = (imports?.nodes ?? []).filter((n) => n.role === "package");
  const dirOf = (p: Node) => String(p.attrs?.dir ?? "").split("/")[0] ?? "";
  const tops = new Set(pkgs.map(dirOf));
  for (const t of tops.size > 1 ? [...tops].sort() : [])
    add({ id: `dir:${t}`, label: `${t}/`, role: "dir", parent: repo, kids: [], files: 0 });
  const pkgDir = new Map<string, string>(); // package name → its dir, longest first
  // One npm scope on every package says nothing on each box: drop it from the label.
  const scopes = new Set(pkgs.map((p) => (p.id.startsWith("@") ? p.id.split("/")[0] : "")));
  const scope = scopes.size === 1 ? [...scopes][0] : "";
  for (const p of pkgs) {
    add({
      id: p.id,
      label: scope ? p.id.slice(scope.length + 1) : p.id,
      role: "package",
      parent: tops.size > 1 ? `dir:${dirOf(p)}` : repo,
      kids: [],
      files: 0,
    });
    detail(p.id).attrs = p.attrs ?? {};
    pkgDir.set(p.id, String(p.attrs?.dir ?? ""));
  }
  const dirs = [...pkgDir].sort(([, a], [, b]) => b.length - a.length);

  /** A file box by package and its path in the package; folders are made on the way. */
  const fileBox = (pkg: string, rel: string): string => {
    const id = `${pkg}/${rel}`;
    if (nodes[id]) return id;
    const parts = rel.replace(/^src\//, "").split("/");
    let parent = pkg;
    for (let i = 0; i < parts.length - 1; i++) {
      const fid = `folder:${pkg}/${parts.slice(0, i + 1).join("/")}`;
      nodes[fid] ??= add({
        id: fid,
        label: `${parts[i]}/`,
        role: "folder",
        parent,
        kids: [],
        files: 0,
      });
      parent = fid;
    }
    add({ id, label: parts.at(-1) ?? rel, role: "file", parent, kids: [], files: 1 });
    return id;
  };
  /** A repo path (`packages/core/src/x.ts`) → its file box. */
  const boxOfPath = (path: string): string | undefined => {
    const hit = dirs.find(([, d]) => d && path.startsWith(d));
    return hit ? fileBox(hit[0], path.slice(hit[1].length)) : undefined;
  };

  for (const n of imports?.nodes ?? [])
    if (n.role === "file" && n.parent) fileBox(n.parent, n.id.slice(n.parent.length + 1));

  const many = (k: number, what: string) => `${k} ${what}${k === 1 ? "" : "s"}`;
  /** Repo paths → the boxes the map has already: a package by its dir, or a file. Never a new one. */
  const paths = (v: unknown): Path[] =>
    (Array.isArray(v) ? (v as string[]) : []).map((path) => {
      const pkg = dirs.find(([, d]) => d === `${path.replace(/\/$/, "")}/`)?.[0];
      const hit = dirs.find(([, d]) => d && path.startsWith(d));
      const file = hit && `${hit[0]}/${path.slice(hit[1].length)}`;
      const box = pkg ?? (file && nodes[file] ? file : undefined);
      return box ? { path, box } : { path };
    });

  // The database: a box per schema and per table; indexes and migrations are detail, not boxes.
  const schema = input.current.schema;
  const tables = (schema?.nodes ?? []).filter((n) => n.role === "table");
  const DB = "db:";
  if (tables.length) {
    add({ id: DB, label: "database", role: "db", parent: repo, kids: [], files: 0, tables: 0 });
    const migrations = (schema?.nodes ?? []).filter((n) => n.role === "migration");
    detail(DB).attrs = {
      migrations: migrations.length,
      latest: migrations.at(-1)?.id.slice("migration:".length) ?? "",
    };
    for (const s of new Set(tables.map((t) => t.parent ?? "schema:public")))
      add({
        id: s,
        label: s.slice("schema:".length),
        role: "schema",
        parent: DB,
        kids: [],
        files: 0,
        tables: 0,
      });
    for (const t of tables) {
      const parent = t.parent ?? "schema:public";
      add({
        id: t.id,
        label: t.id.slice(t.id.indexOf(".") + 1),
        role: "table",
        parent,
        kids: [],
        files: 0,
      });
      detail(t.id).attrs = t.attrs ?? {};
      for (const up of [parent, DB])
        (nodes[up] as TreeNode).tables = ((nodes[up] as TreeNode).tables ?? 0) + 1;
    }
    for (const n of schema?.nodes ?? [])
      if (n.role === "index" && n.parent && nodes[n.parent])
        detail(n.parent).indexes.push({
          id: n.id,
          name: n.id.slice(`index:${n.parent.slice("table:".length)}.`.length),
          kind: "index",
          sig: String(n.attrs?.def ?? ""),
        });
  }

  // The systems: a box per system and per part in it; each relation is a seam in its ends' detail.
  const sys = input.current.systems;
  const SYS = "sys:";
  if (sys?.nodes.length) {
    add({ id: SYS, label: "systems", role: "systems", parent: repo, kids: [], files: 0 });
    // Parents first: a part may sit in a host part.
    const byId = new Map(sys.nodes.map((n) => [n.id, n]));
    const depth = (n: Node): number => {
      const p = n.parent ? byId.get(n.parent) : undefined;
      return p ? 1 + depth(p) : 0;
    };
    for (const n of [...sys.nodes].sort((a, b) => depth(a) - depth(b))) {
      const kind = String(n.attrs?.kind ?? n.role);
      add({
        id: n.id,
        label: String(n.attrs?.title ?? n.id.slice("system:".length)),
        role: n.role,
        parent: n.parent ?? SYS,
        kids: [],
        files: 0,
        sub: String(n.attrs?.technology ?? kind),
        kind,
      });
      detail(n.id).attrs = n.attrs ?? {};
    }
    (nodes[SYS] as TreeNode).sub = many(nodes[SYS]?.kids.length ?? 0, "system");
    for (const n of sys.nodes) {
      const b = nodes[n.id] as TreeNode;
      if (b.kids.length) b.sub = many(b.kids.length, "part");
    }
    for (const n of sys.nodes) {
      const code = paths(n.attrs?.code);
      if (code.length) detail(n.id).code = code;
    }
    for (const e of sys.edges) {
      const titles = Array.isArray(e.attrs?.title) ? (e.attrs.title as string[]) : [];
      const s = { kind: e.kind, titles, here: paths(e.attrs?.here) };
      detail(e.from).seams.push({ ...s, id: e.to, out: true });
      detail(e.to).seams.push({ ...s, id: e.from, out: false });
    }
  }

  // Exports and services into their file's detail.
  const index: ViewData["index"] = [];

  // The screens: a box per app and per page in tab order; a page's file and a story list each
  // other in that file's detail.
  const ui = input.current.ui;
  const UI = "ui:";
  const apps = (ui?.nodes ?? []).filter((n) => n.role === "app");
  if (apps.length) {
    add({ id: UI, label: "screens", role: "screens", parent: repo, kids: [], files: 0 });
    // Two apps can share a name, one per workspace: each label says which.
    const names = new Map<string, number>();
    for (const a of apps)
      names.set(String(a.attrs?.name), (names.get(String(a.attrs?.name)) ?? 0) + 1);
    for (const [i, a] of apps.entries()) {
      const name = String(a.attrs?.name ?? a.id.slice(UI.length));
      const twin = (names.get(name) ?? 0) > 1;
      add({
        id: a.id,
        label: twin ? `${name} · ${a.attrs?.workspace === "wren" ? "Wren" : "client"}` : name,
        role: "app",
        parent: UI,
        kids: [],
        files: 0,
        order: i,
      });
      detail(a.id).attrs = a.attrs ?? {};
      const code = paths(a.attrs?.file ? [a.attrs.file] : []);
      if (code.length) detail(a.id).code = code;
      index.push({ name: String(a.attrs?.name), kind: "app", box: a.id });
    }
    for (const n of ui?.nodes ?? []) {
      if (n.role !== "screen" || !n.parent || !nodes[n.parent]) continue;
      const a = n.attrs ?? {};
      add({
        id: n.id,
        label: String(a.label),
        role: "screen",
        parent: n.parent,
        kids: [],
        files: 0,
        sub: a.record ? `${a.template} of ${a.record}` : String(a.template),
        order: Number(a.order),
      });
      detail(n.id).attrs = a;
      const code = paths(a.file ? [a.file] : []);
      if (code.length) detail(n.id).code = code;
      for (const p of code) {
        if (!p.box) continue;
        const d = detail(p.box);
        d.screens = [...(d.screens ?? []), n.id];
      }
      index.push({ name: String(a.label), kind: "screen", box: n.id });
    }
    (nodes[UI] as TreeNode).sub = many(apps.length, "app");
    for (const a of apps) {
      const b = nodes[a.id] as TreeNode;
      b.sub = many(b.kids.length, "page");
    }
    for (const n of ui?.nodes ?? []) {
      if (n.role !== "story") continue;
      const story: StoryRef = {
        id: n.id,
        title: String(n.attrs?.title),
        file: String(n.attrs?.file),
      };
      const own = paths([story.file])[0]?.box;
      if (own) story.box = own;
      for (const p of paths(n.attrs?.shows)) {
        if (!p.box) continue;
        const d = detail(p.box);
        d.stories = [...(d.stories ?? []), story];
      }
      index.push({ name: story.title, kind: "story", box: own ?? UI });
    }
  }
  const itemDrift = new Map<string, Drift>();
  const api = input.current.api;
  for (const n of api?.nodes ?? []) {
    const box = boxOfPath(String(n.attrs?.file));
    if (!box) continue;
    const name = n.id.slice(n.id.indexOf("#") + 1);
    detail(box).exports.push({
      id: n.id,
      name,
      kind: String(n.attrs?.kind),
      sig: String(n.attrs?.sig ?? ""),
      ...(n.attrs?.inferred ? { inferred: true } : {}),
    });
    index.push({ name, kind: String(n.attrs?.kind), box });
  }
  const routes = input.current.routes;
  const services = new Map<string, { svc: Service; box: string }>();
  for (const n of routes?.nodes ?? []) {
    if (n.role !== "service") continue;
    const box = boxOfPath(String(n.attrs?.file));
    if (!box) continue;
    const svc: Service = {
      id: n.id,
      name: n.id.slice("service:".length),
      kind: String(n.attrs?.kind),
      box,
      routeCount: 0,
      routes: [],
    };
    services.set(n.id, { svc, box });
    detail(box).services.push(svc);
    index.push({
      name: svc.name,
      kind: svc.kind === "service" ? "service" : `${svc.kind} service`,
      box,
    });
  }
  for (const n of routes?.nodes ?? []) {
    const s = n.role === "route" && n.parent ? services.get(n.parent) : undefined;
    if (!s) continue;
    const name = n.id.slice(n.id.lastIndexOf("/") + 1);
    s.svc.routeCount++;
    s.svc.routes.push({
      id: n.id,
      name,
      kind: String(n.attrs?.wrap),
      sig: `${n.attrs?.input} → ${n.attrs?.output}`,
    });
    index.push({ name: `${s.svc.name}/${name}`, kind: "route", box: s.box });
  }

  // A screen's slice: a route goes to its service's file box, a table or system to its own box.
  const routeBox = new Map<string, string>();
  for (const n of routes?.nodes ?? []) {
    const s = n.role === "route" && n.parent ? services.get(n.parent) : undefined;
    if (s) routeBox.set(n.id, s.box);
  }
  // The patterns: a box each; its detail lists the routes that break it, each route row the same.
  const pats = input.current.patterns;
  const PAT = "pat:";
  const routeItem = new Map(
    [...services.values()].flatMap(({ svc }) => svc.routes.map((r) => [r.id, r] as const)),
  );
  if (pats?.nodes.length) {
    add({ id: PAT, label: "patterns", role: "patterns", parent: repo, kids: [], files: 0 });
    for (const n of pats.nodes) {
      const name = n.id.slice("pattern:".length);
      const breaks = pats.edges.filter((e) => e.from === n.id && e.kind === "breaks");
      const holds = pats.edges.filter((e) => e.from === n.id && e.kind === "holds").length;
      add({
        id: n.id,
        label: name,
        role: "pattern",
        parent: PAT,
        kids: [],
        files: 0,
        sub: `${holds} hold · ${breaks.length} break${breaks.length === 1 ? "" : "s"}`,
      });
      detail(n.id).attrs = n.attrs ?? {};
      detail(n.id).pattern = {
        holds,
        breaks: breaks
          .map((e) => {
            const box = routeBox.get(e.to);
            return box ? { route: e.to, box } : { route: e.to };
          })
          .sort((a, b) => (a.route < b.route ? -1 : 1)),
      };
      for (const e of breaks) {
        const r = routeItem.get(e.to);
        if (r) r.breaks = [...(r.breaks ?? []), name];
      }
      index.push({ name, kind: "pattern", box: n.id });
    }
    (nodes[PAT] as TreeNode).sub = many(pats.nodes.length, "pattern");
  }

  for (const [id, sl] of slices(
    {
      ui: input.current.ui ?? null,
      routes: routes ?? null,
      systems: input.current.systems ?? null,
    },
    (id) => routeBox.get(id) ?? (nodes[id] ? id : undefined),
  ))
    if (nodes[id]) detail(id).slice = sl;

  // Each box's chain from the repo, for lifting edges and counting.
  const chain = (id: string): string[] => {
    const out: string[] = [];
    for (let n: TreeNode | undefined = nodes[id]; n; n = n.parent ? nodes[n.parent] : undefined)
      out.unshift(n.id);
    return out;
  };
  const chains = new Map(Object.keys(nodes).map((id) => [id, chain(id)]));
  const pkgOf = (id: string) => chains.get(id)?.find((x) => nodes[x]?.role === "package");
  for (const n of Object.values(nodes)) {
    if (n.role !== "file") continue;
    const d = details[n.id];
    for (const up of chains.get(n.id) ?? []) {
      const u = nodes[up];
      if (!u || up === n.id) continue;
      u.files++;
      if (!d) continue;
      const ud = detail(up);
      ud.exportCount += d.exports.length;
      ud.inferred += d.exports.filter((e) => e.inferred).length;
      ud.services.push(...d.services.map((x) => ({ ...x, routes: [] })));
    }
    if (d) {
      d.exportCount = d.exports.length;
      d.inferred = d.exports.filter((e) => e.inferred).length;
    }
  }

  for (const l of input.cost?.lines ?? []) {
    if (!l.owner || !nodes[l.owner]) continue;
    const d = detail(l.owner);
    d.cost ??= { usd: 0, days: input.cost?.days ?? 0, lines: [] };
    d.cost.usd += l.usd;
    d.cost.lines.push({ source: l.source, key: l.key, usd: l.usd });
  }

  const rec = input.recent;
  if (rec) {
    const put = (
      box: string | undefined,
      c: { commits: number; added: number; removed: number },
    ) => {
      const n = box ? nodes[box] : undefined;
      if (!box || !n) return;
      n.commits = c.commits;
      // up to the repo: a box's busiest child (a sum would count a commit once per file)
      for (let p = n.parent; p && nodes[p] && nodes[p]?.role !== "repo"; p = nodes[p]?.parent) {
        const up = nodes[p] as TreeNode;
        up.commits = Math.max(up.commits ?? 0, c.commits);
      }
      detail(box).recent = {
        days: rec.days,
        commits: c.commits,
        added: c.added,
        removed: c.removed,
      };
    };
    for (const p of rec.packages) put(p.id, p);
    for (const f of rec.files) {
      const hit = dirs.find(([, d]) => d && f.path.startsWith(d));
      if (hit) put(`${hit[0]}/${f.path.slice(hit[1].length)}`, f);
    }
  }

  // Lift file → file imports: each edge sits on the one level where its ends part.
  type Acc = { n: number; type: boolean };
  const levelEdges = new Map<string, Map<string, Acc>>(); // container → `from\0to` → count
  const links = new Map<string, Map<string, Acc>>(); // `uses\0id` | `usedBy\0id` → other → count
  const bump = (m: Map<string, Acc>, k: string, type: boolean) => {
    const a = m.get(k) ?? { n: 0, type: true };
    a.n++;
    a.type &&= type;
    m.set(k, a);
  };
  const link = (side: "uses" | "usedBy", id: string, other: string, type: boolean) => {
    const k = `${side}\0${id}`;
    const m = links.get(k) ?? new Map<string, Acc>();
    links.set(k, m);
    bump(m, other, type);
  };
  const leaf = (id: string) => {
    const r = nodes[id]?.role;
    return r === "file" || r === "table" || r === "system" || r === "part";
  };
  for (const e of [...(imports?.edges ?? []), ...(schema?.edges ?? []), ...(sys?.edges ?? [])]) {
    if (!leaf(e.from) || !leaf(e.to)) continue;
    const a = chains.get(e.from) ?? [];
    const b = chains.get(e.to) ?? [];
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    const container = a[i - 1];
    const [fa, fb] = [a[i], b[i]];
    if (!container || !fa || !fb) continue;
    const type = e.attrs?.type === true;
    const m = levelEdges.get(container) ?? new Map<string, Acc>();
    levelEdges.set(container, m);
    bump(m, `${fa}\0${fb}`, type);
    // Detail links: files list files; a box outside the other's package lists that package;
    // a folder inside the same package lists the box at its own depth.
    for (let j = i; j < a.length; j++) {
      const x = a[j] as string;
      const role = nodes[x]?.role;
      if (role === "dir") continue;
      const other =
        role === "file" || role === "table"
          ? e.to
          : pkgOf(x) !== pkgOf(e.to)
            ? (pkgOf(e.to) ?? e.to)
            : (b[Math.min(j, b.length - 1)] as string);
      link("uses", x, other, type);
    }
    for (let j = i; j < b.length; j++) {
      const x = b[j] as string;
      const role = nodes[x]?.role;
      if (role === "dir") continue;
      const other =
        role === "file" || role === "table"
          ? e.from
          : pkgOf(x) !== pkgOf(e.from)
            ? (pkgOf(e.from) ?? e.from)
            : (a[Math.min(j, a.length - 1)] as string);
      link("usedBy", x, other, type);
    }
  }
  const toLinks = (m: Map<string, Acc> | undefined): Link[] =>
    [...(m ?? [])]
      .map(([id, a]) => ({ id, n: a.n, type: a.type }))
      .sort((x, y) => y.n - x.n || (x.id < y.id ? -1 : 1));
  for (const id of Object.keys(nodes)) {
    const u = links.get(`uses\0${id}`);
    const b = links.get(`usedBy\0${id}`);
    if (!u && !b) continue;
    const d = detail(id);
    d.uses = toLinks(u);
    d.usedBy = toLinks(b);
  }

  // Drift: what changed since the approved map, on the box that shows it.
  const approvedAny = Object.values(input.approved).some(Boolean);
  const mark = (id: string | undefined, d: Drift) => {
    if (!id || !nodes[id]) return;
    const n = nodes[id] as TreeNode;
    if (n.drift !== "add") n.drift = d;
  };
  const removed = (id: string | undefined, what: string) => {
    if (!id) return;
    const n = nodes[id];
    if (!n) return;
    n.removed = [...(n.removed ?? []), what];
    mark(id, "change");
  };
  /** The nearest box for a node id that may be gone: a file path climbs to its package. */
  const nearest = (id: string): string | undefined => {
    for (let x = id; x; x = x.slice(0, Math.max(0, x.lastIndexOf("/")))) if (nodes[x]) return x;
    return dirs.find(([p]) => id.startsWith(`${p}/`))?.[0];
  };
  if (approvedAny) {
    for (const [layer, cur] of Object.entries(input.current)) {
      const old = input.approved[layer];
      if (!cur || !old) continue;
      const before = new Map<string, Node>(old.nodes.map((n) => [n.id, n]));
      const now = new Map<string, Node>(cur.nodes.map((n) => [n.id, n]));
      const edgeFrom = new Map<string, Edge>(
        [...old.edges, ...cur.edges].map((e) => [edgeId(e), e]),
      );
      const boxOfNode = (id: string): string | undefined => {
        const n = now.get(id) ?? before.get(id);
        if (!n) return undefined;
        if (layer === "imports") return nearest(n.id);
        if (layer === "schema")
          return n.role === "index" ? n.parent : n.role === "migration" ? DB : n.id;
        if (layer === "systems" || layer === "patterns") return n.id;
        // A story marks its own file; a page or app that is gone marks the box above it.
        if (layer === "ui")
          return n.role === "story"
            ? boxOfPath(String(n.attrs?.file))
            : nodes[n.id]
              ? n.id
              : n.parent && nodes[n.parent]
                ? n.parent
                : UI;
        if (n.role === "route") return n.parent ? services.get(n.parent)?.box : undefined;
        return n.attrs?.file ? boxOfPath(String(n.attrs.file)) : undefined;
      };
      for (const c of diff(old, cur)) {
        const id = c.what === "edge" ? (edgeFrom.get(c.id)?.from ?? "") : c.id;
        const box = boxOfNode(id);
        if (c.what === "node" && layer !== "imports")
          itemDrift.set(c.id, c.op === "add" ? "add" : "change");
        if (c.what === "node" && c.op === "remove") removed(box, c.id);
        else mark(box, c.what === "node" && c.op === "add" && box === c.id ? "add" : "change");
      }
    }
    for (const d of Object.values(details)) {
      for (const x of d.exports) {
        const dr = itemDrift.get(x.id);
        if (dr) x.drift = dr;
      }
      for (const x of d.indexes) {
        const dr = itemDrift.get(x.id);
        if (dr) x.drift = dr;
      }
      for (const s of d.services) {
        const dr = itemDrift.get(s.id);
        if (dr) s.drift = dr;
        for (const r of s.routes) {
          const rd = itemDrift.get(r.id);
          if (rd) r.drift = rd;
        }
      }
    }
    for (const n of Object.values(nodes))
      if (n.drift)
        for (const up of chains.get(n.id) ?? []) {
          const u = nodes[up];
          if (u && up !== n.id && !u.drift) u.drift = "inside";
        }
  }

  // Cards: each on the boxes it covers (an export's card on its file), a badge where one is due.
  const boxOf = new Map<string, string>();
  for (const [box, d] of Object.entries(details)) for (const e of d.exports) boxOf.set(e.id, box);
  const held = new Set<string>();
  for (const c of input.cards ?? []) {
    const ref = { path: c.path, type: c.type, why: c.why, stale: c.stale };
    const boxes = new Set(c.covers.map((id) => (nodes[id] ? id : boxOf.get(id))).filter(Boolean));
    for (const n of pats?.nodes ?? []) if (n.attrs?.card === c.path) boxes.add(n.id);
    for (const b of boxes as Set<string>) {
      detail(b).cards.push(ref);
      if (c.stale) (nodes[b] as TreeNode).badge = "stale";
      for (const up of chains.get(b) ?? []) held.add(up);
    }
  }
  if (input.cards)
    for (const n of Object.values(nodes))
      if (!n.badge && input.require?.includes(n.role) && !held.has(n.id)) n.badge = "none";

  // One-liners: any layer's `description`, on the box that shows the node.
  for (const g of Object.values(input.current))
    for (const n of g?.nodes ?? []) {
      const d = n.attrs?.description;
      const t = nodes[n.id];
      if (t && typeof d === "string" && d) t.line = d;
    }

  // Each container's kids and the lines between them; the page lays them out (orrery `nest`).
  const levels: Record<string, Level> = {};
  /** Tab order where the layer gives one (apps, pages), else by id. */
  const byOrder = (a: string, b: string) =>
    (nodes[a]?.order ?? -1) - (nodes[b]?.order ?? -1) || (a < b ? -1 : a > b ? 1 : 0);
  const fanIn = new Map<string, number>();
  for (const m of levelEdges.values())
    for (const [k] of m) {
      const to = k.split("\0")[1] as string;
      fanIn.set(to, (fanIn.get(to) ?? 0) + 1);
    }
  for (const n of Object.values(nodes)) n.kids.sort(byOrder);
  for (const c of Object.values(nodes)) {
    if (!c.kids.length) continue;
    const edges = [...(levelEdges.get(c.id) ?? new Map<string, Acc>())].map(([k, a]): LevelEdge => {
      const [from, to] = k.split("\0") as [string, string];
      return { from, to, n: a.n, type: a.type };
    });
    for (const i of implied(edges)) (edges[i] as LevelEdge).implied = true;
    // No lines: a layered layout packs the boxes by size and loses their order; a grid keeps it.
    const grid = c.kids.length > GRID_OVER || !edges.length;
    const ids = grid
      ? [...c.kids].sort((a, b) => (fanIn.get(b) ?? 0) - (fanIn.get(a) ?? 0) || byOrder(a, b))
      : c.kids;
    levels[c.id] = {
      ...(grid ? { grid: true } : {}),
      boxes: ids.map((id) => ({ id, fanIn: fanIn.get(id) ?? 0 })),
      edges,
    };
  }

  const counts: Record<string, number> = {
    files: nodes[repo]?.files ?? 0,
    packages: pkgs.length,
    exports: details[repo]?.exportCount ?? 0,
    services: services.size,
    routes: routes?.nodes.filter((n) => n.role === "route").length ?? 0,
    tables: tables.length,
    systems: sys?.nodes.filter((n) => n.role === "system").length ?? 0,
    screens: ui?.nodes.filter((n) => n.role === "screen").length ?? 0,
    drift: Object.values(nodes).filter((n) => n.drift && n.drift !== "inside").length,
  };
  return {
    repo: repo.slice("repo:".length),
    root: input.root,
    approved: approvedAny,
    nodes,
    details,
    // Fixed key order: a dump should not churn.
    levels: Object.fromEntries(Object.entries(levels).sort(([a], [b]) => a.localeCompare(b))),
    index,
    counts,
    ...(input.storybook ? { storybook: input.storybook, dirs } : {}),
    ...(rec ? { recentDays: rec.days } : {}),
  };
}
