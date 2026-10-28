/**
 * Every layer's graph → one tree to zoom (repo → top folder → package → source folder → file,
 * repo → database → schema → table, and repo → systems → system → part), each level laid out once with ELK. Exports and routes are not boxes: they sit in their file's
 * detail, so a level stays a readable dependency graph.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { basename } from "node:path";
import type { ELK as Elk, ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";
import { diff } from "../diff.js";
import { type Edge, edgeId, type Graph, type Node } from "../graph.js";
import type {
  CardView,
  Detail,
  Drift,
  LayoutCache,
  Level,
  LevelEdge,
  Link,
  Path,
  Service,
  TreeNode,
  ViewData,
} from "./types.js";

// elkjs is CommonJS; its default export does not survive NodeNext's interop.
const ELK: new () => Elk = createRequire(import.meta.url)("elkjs/lib/elk.bundled.js");

export interface ViewInput {
  root: string;
  current: Record<string, Graph | null>;
  approved: Record<string, Graph | null>;
  /** Read and filled in place: layouts by input hash. Entries no level used are dropped. */
  cache?: LayoutCache;
  cards?: CardView[];
  /** Node roles that need a card (`kestrel.json` cards.require). */
  require?: readonly string[];
}

/** Bump when `place` changes: the cache key is its input, not its code. */
const LAYOUT_VERSION = 2;

/** Over this many boxes a layered graph is a hairball, and ELK takes seconds. */
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
    // Parents first: LikeC4 ids nest by dots, so a shorter id is never a child of a longer one.
    for (const n of [...sys.nodes].sort(
      (a, b) => a.id.split(".").length - b.id.split(".").length,
    )) {
      add({
        id: n.id,
        label: String(n.attrs?.title ?? n.id.slice("system:".length)),
        role: n.role,
        parent: n.parent ?? SYS,
        kids: [],
        files: 0,
        sub: String(n.attrs?.kind ?? n.role),
      });
      detail(n.id).attrs = n.attrs ?? {};
    }
    const many = (k: number, what: string) => `${k} ${what}${k === 1 ? "" : "s"}`;
    (nodes[SYS] as TreeNode).sub = many(nodes[SYS]?.kids.length ?? 0, "system");
    for (const n of sys.nodes) {
      const b = nodes[n.id] as TreeNode;
      if (b.kids.length) b.sub = many(b.kids.length, "part");
    }
    const paths = (v: unknown): Path[] =>
      (Array.isArray(v) ? (v as string[]) : []).map((path) => {
        // A box the map has already: a package by its dir, or a file. Never a new one.
        const pkg = dirs.find(([, d]) => d === `${path.replace(/\/$/, "")}/`)?.[0];
        const hit = dirs.find(([, d]) => d && path.startsWith(d));
        const file = hit && `${hit[0]}/${path.slice(hit[1].length)}`;
        const box = pkg ?? (file && nodes[file] ? file : undefined);
        return box ? { path, box } : { path };
      });
    for (const n of sys.nodes) {
      const code = paths(n.attrs?.code);
      if (code.length) detail(n.id).code = code;
    }
    for (const e of sys.edges) {
      const titles = Array.isArray(e.attrs?.title) ? (e.attrs.title as string[]) : [];
      const [here, there] = [paths(e.attrs?.here), paths(e.attrs?.there)];
      const s = { kind: e.kind, titles, here, there };
      detail(e.from).seams.push({ ...s, id: e.to, out: true });
      detail(e.to).seams.push({ ...s, id: e.from, out: false });
    }
  }

  // Exports and services into their file's detail.
  const index: ViewData["index"] = [];
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
        if (layer === "systems") return n.id;
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
    for (const b of boxes as Set<string>) {
      detail(b).cards.push(ref);
      if (c.stale) (nodes[b] as TreeNode).badge = "stale";
      for (const up of chains.get(b) ?? []) held.add(up);
    }
  }
  if (input.cards)
    for (const n of Object.values(nodes))
      if (!n.badge && input.require?.includes(n.role) && !held.has(n.id)) n.badge = "none";

  // Lay out every container's kids once.
  const elk = new ELK();
  const cache = input.cache ?? {};
  const used: LayoutCache = {};
  /** ELK for a readable level; a grid by fan-in for a flat one, lines left to the page. */
  const place = async (graph: ElkNode, grid: boolean): Promise<LayoutCache[string]> => {
    const kids = graph.children ?? [];
    if (grid) {
      const order = [...kids].sort(
        (a, b) => (fanIn.get(b.id) ?? 0) - (fanIn.get(a.id) ?? 0) || a.id.localeCompare(b.id),
      );
      const cols = Math.min(8, Math.ceil(Math.sqrt(order.length * 1.8)));
      const cw = Math.max(...order.map((k) => k.width ?? 0)) + 24;
      const rh = Math.max(...order.map((k) => k.height ?? 0)) + 24;
      return {
        w: cols * cw,
        h: Math.ceil(order.length / cols) * rh,
        grid: true,
        boxes: order.map((k, i) => [k.id, (i % cols) * cw, Math.floor(i / cols) * rh]),
        points: [],
      };
    }
    const out = await elk.layout(graph);
    return {
      w: Math.round(out.width ?? 0),
      h: Math.round(out.height ?? 0),
      boxes: (out.children ?? []).map((b) => [b.id, Math.round(b.x ?? 0), Math.round(b.y ?? 0)]),
      points: ((out.edges ?? []) as ElkExtendedEdge[])
        .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
        .map((e) => {
          const q = e.sections?.[0];
          return q
            ? [q.startPoint, ...(q.bendPoints ?? []), q.endPoint].map((v) => [
                Math.round(v.x),
                Math.round(v.y),
              ])
            : [];
        }),
    };
  };
  const levels: Record<string, Level> = {};
  const fanIn = new Map<string, number>();
  for (const m of levelEdges.values())
    for (const [k] of m) {
      const to = k.split("\0")[1] as string;
      fanIn.set(to, (fanIn.get(to) ?? 0) + 1);
    }
  await Promise.all(
    Object.values(nodes)
      .filter((n) => n.kids.length)
      .map(async (c) => {
        const m = levelEdges.get(c.id) ?? new Map<string, Acc>();
        const size = (id: string) => {
          const n = nodes[id] as TreeNode;
          const s = 1 + Math.min(0.5, Math.log2(1 + (fanIn.get(id) ?? 0)) / 10);
          const w = Math.max(132, Math.min(300, n.label.length * 7.6 + 48));
          return { width: Math.round(w * s), height: Math.round(52 * s) };
        };
        const edges = [...m].map(([k, a], i) => {
          const [from, to] = k.split("\0") as [string, string];
          return { id: `e${i}`, sources: [from], targets: [to], from, to, ...a };
        });
        const graph: ElkNode = {
          id: c.id,
          layoutOptions: {
            "elk.algorithm": "layered",
            "elk.direction": "RIGHT",
            "elk.edgeRouting": "ORTHOGONAL",
            "elk.layered.spacing.nodeNodeBetweenLayers": "56",
            "elk.spacing.nodeNode": "28",
            "elk.spacing.componentComponent": "40",
            "elk.aspectRatio": "1.8",
            "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
          },
          children: [...c.kids].sort().map((id) => ({ id, ...size(id) })),
          edges: edges.map(({ id, sources, targets }) => ({ id, sources, targets })),
        };
        const key = createHash("sha1")
          .update(`${LAYOUT_VERSION}${JSON.stringify(graph)}`)
          .digest("base64url");
        const hit = cache[key] ?? (await place(graph, c.kids.length > GRID_OVER));
        used[key] = hit;
        const at = new Map(hit.boxes.map(([id, x, y]) => [id, { x, y }]));
        levels[c.id] = {
          w: hit.w,
          h: hit.h,
          ...(hit.grid ? { grid: true } : {}),
          boxes: (graph.children ?? []).map((b) => ({
            id: b.id,
            ...(at.get(b.id) ?? { x: 0, y: 0 }),
            w: b.width ?? 0,
            h: b.height ?? 0,
            fanIn: fanIn.get(b.id) ?? 0,
          })),
          edges: edges.map(
            (e, i): LevelEdge => ({
              from: e.from,
              to: e.to,
              n: e.n,
              type: e.type,
              points: hit.points[i] ?? [],
            }),
          ),
        };
      }),
  );
  for (const n of Object.values(nodes)) n.kids.sort();
  if (input.cache) {
    for (const k of Object.keys(input.cache)) delete input.cache[k];
    Object.assign(input.cache, used);
  }

  const counts: Record<string, number> = {
    files: nodes[repo]?.files ?? 0,
    packages: pkgs.length,
    exports: details[repo]?.exportCount ?? 0,
    services: services.size,
    routes: routes?.nodes.filter((n) => n.role === "route").length ?? 0,
    tables: tables.length,
    systems: sys?.nodes.filter((n) => n.role === "system").length ?? 0,
    drift: Object.values(nodes).filter((n) => n.drift && n.drift !== "inside").length,
  };
  return {
    repo: repo.slice("repo:".length),
    root: input.root,
    approved: approvedAny,
    nodes,
    details,
    // Fixed key order: cache hits finish first, and a dump should not churn.
    levels: Object.fromEntries(Object.entries(levels).sort(([a], [b]) => a.localeCompare(b))),
    index,
    counts,
  };
}
