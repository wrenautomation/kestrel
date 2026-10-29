import { describe, expect, it } from "vitest";
import type { Edge, Graph, Node } from "../graph.js";
import { fromDump } from "../layers/ui.js";
import { buildView, GRID_OVER } from "./build.js";
import { slices } from "./slice.js";

const pkg = (id: string, dir: string): Node => ({ id, role: "package", group: id, attrs: { dir } });
const file = (p: string, rel: string): Node => ({
  id: `${p}/${rel}`,
  role: "file",
  parent: p,
  group: p,
});
const imp = (from: string, to: string, type = false): Edge => ({
  from,
  to,
  kind: "imports",
  ...(type ? { attrs: { type } } : {}),
});

/** Two packages and one app; `a` imports `b` twice, the app imports `a`. */
const imports = (extra: Node[] = []): Graph => ({
  layer: "imports",
  nodes: [
    { id: "repo:r", role: "repo", group: "_repo" },
    pkg("@s/a", "packages/a/"),
    pkg("@s/b", "packages/b/"),
    pkg("@s/web", "apps/web/"),
    file("@s/a", "src/x.ts"),
    file("@s/a", "src/deep/y.ts"),
    file("@s/b", "src/z.ts"),
    file("@s/web", "src/main.ts"),
    ...extra,
  ],
  edges: [
    imp("@s/a/src/x.ts", "@s/b/src/z.ts"),
    imp("@s/a/src/deep/y.ts", "@s/b/src/z.ts", true),
    imp("@s/a/src/x.ts", "@s/a/src/deep/y.ts"),
    imp("@s/web/src/main.ts", "@s/a/src/x.ts"),
  ],
});

const api: Graph = {
  layer: "api",
  nodes: [
    {
      id: "@s/a#run",
      role: "export",
      group: "@s/a",
      attrs: { file: "packages/a/src/x.ts", kind: "function", sig: "() => void" },
    },
  ],
  edges: [],
};

const view = (current: Graph, approved: Graph | null = null) =>
  buildView({
    root: "/r",
    current: { imports: current, api },
    approved: { imports: approved, api: approved ? api : null },
  });

describe("buildView", () => {
  it("folds repo → top folder → package → folder → file, scope off the labels", async () => {
    const v = await view(imports());
    expect(v.nodes["repo:r"]?.kids).toEqual(["dir:apps", "dir:packages"]);
    expect(v.nodes["dir:packages"]?.kids).toEqual(["@s/a", "@s/b"]);
    expect(v.nodes["@s/a"]?.label).toBe("a");
    expect(v.nodes["@s/a"]?.kids).toEqual(["@s/a/src/x.ts", "folder:@s/a/deep"]);
    expect(v.nodes["folder:@s/a/deep"]?.kids).toEqual(["@s/a/src/deep/y.ts"]);
    expect(v.nodes["@s/a"]?.files).toBe(2);
    expect(v.counts.files).toBe(4);
  });

  it("lifts each import to the level where its ends part", async () => {
    const v = await view(imports());
    const at = (lvl: string) => v.levels[lvl]?.edges.map((e) => [e.from, e.to, e.n, e.type]) ?? [];
    expect(at("dir:packages")).toEqual([["@s/a", "@s/b", 2, false]]);
    expect(at("repo:r")).toEqual([["dir:apps", "dir:packages", 1, false]]);
    expect(at("@s/a")).toEqual([["@s/a/src/x.ts", "folder:@s/a/deep", 1, false]]);
    expect(v.details["@s/b"]?.usedBy).toEqual([{ id: "@s/a", n: 2, type: false }]);
  });

  it("puts exports in their file's detail and counts them up the tree", async () => {
    const v = await view(imports());
    expect(v.details["@s/a/src/x.ts"]?.exports.map((e) => e.name)).toEqual(["run"]);
    expect(v.details["@s/a"]?.exportCount).toBe(1);
    expect(v.index).toContainEqual({ name: "run", kind: "function", box: "@s/a/src/x.ts" });
  });

  it("marks a new file, and each box above it as changed inside", async () => {
    const extra = [file("@s/b", "src/new.ts")];
    const v = await view(imports(extra), imports());
    expect(v.approved).toBe(true);
    expect(v.nodes["@s/b/src/new.ts"]?.drift).toBe("add");
    expect(v.nodes["@s/b"]?.drift).toBe("inside");
    expect(v.nodes["@s/a/src/x.ts"]?.drift).toBeUndefined();
  });

  it("lays a flat folder out as a grid, most used first", async () => {
    const many = Array.from({ length: GRID_OVER + 1 }, (_, i) => file("@s/b", `src/f${i}.ts`));
    const g = imports(many);
    g.edges.push(imp("@s/b/src/f0.ts", "@s/b/src/f9.ts"), imp("@s/b/src/f1.ts", "@s/b/src/f9.ts"));
    const v = await view(g);
    const lvl = v.levels["@s/b"];
    expect(lvl?.grid).toBe(true);
    expect(lvl?.boxes[0]?.id).toBe("@s/b/src/f9.ts");
    expect(v.levels["@s/a"]?.grid).toBeUndefined();
  });

  it("puts a layer's one-liner on its box", async () => {
    const g = imports();
    const pkg = g.nodes.find((n) => n.id === "@s/a");
    if (pkg) pkg.attrs = { ...pkg.attrs, description: "Does a." };
    const v = await view(g);
    expect(v.nodes["@s/a"]?.line).toBe("Does a.");
    expect(v.nodes["@s/b"]?.line).toBeUndefined();
  });

  it("puts a card on each box it covers, and badges a package with none", async () => {
    const v = await buildView({
      root: "/r",
      current: { imports: imports(), api },
      approved: { imports: null, api: null },
      cards: [
        { path: "map/x.md", type: "object", why: "Because.", stale: true, covers: ["@s/a#run"] },
      ],
      require: ["package"],
    });
    expect(v.details["@s/a/src/x.ts"]?.cards).toEqual([
      { path: "map/x.md", type: "object", why: "Because.", stale: true },
    ]);
    expect(v.nodes["@s/a/src/x.ts"]?.badge).toBe("stale");
    expect(v.nodes["@s/a"]?.badge).toBeUndefined();
    expect(v.nodes["@s/b"]?.badge).toBe("none");
  });

  it("folds the database into schemas and tables, keys lifted like imports", async () => {
    const schema: Graph = {
      layer: "schema",
      nodes: [
        { id: "schema:public", role: "schema", group: "public" },
        { id: "schema:books", role: "schema", group: "books" },
        { id: "table:public.leads", role: "table", parent: "schema:public", group: "public" },
        { id: "table:public.clients", role: "table", parent: "schema:public", group: "public" },
        { id: "table:books.orders", role: "table", parent: "schema:books", group: "books" },
        {
          id: "index:public.leads.leads_pkey",
          role: "index",
          parent: "table:public.leads",
          group: "public",
          attrs: { def: "CREATE UNIQUE INDEX leads_pkey ON leads (id)" },
        },
        { id: "migration:0001.sql", role: "migration", group: "migrations" },
      ],
      edges: [
        { from: "table:public.leads", to: "table:public.clients", kind: "references" },
        { from: "table:books.orders", to: "table:public.clients", kind: "references" },
      ],
    };
    const v = await buildView({
      root: "/r",
      current: { imports: imports(), api, schema },
      approved: { imports: null, api: null, schema: null },
    });
    expect(v.nodes["repo:r"]?.kids).toEqual(["db:", "dir:apps", "dir:packages"]);
    expect(v.nodes["db:"]?.tables).toBe(3);
    expect(v.nodes["schema:public"]?.kids).toEqual(["table:public.clients", "table:public.leads"]);
    expect(v.nodes["table:public.leads"]?.label).toBe("leads");
    expect(v.details["table:public.leads"]?.indexes.map((i) => i.name)).toEqual(["leads_pkey"]);
    expect(v.details["db:"]?.attrs).toEqual({ migrations: 1, latest: "0001.sql" });
    const at = (lvl: string) => v.levels[lvl]?.edges.map((e) => [e.from, e.to]) ?? [];
    expect(at("schema:public")).toEqual([["table:public.leads", "table:public.clients"]]);
    expect(at("db:")).toEqual([["schema:books", "schema:public"]]);
    expect(v.details["table:public.clients"]?.usedBy.map((l) => l.id)).toEqual([
      "table:books.orders",
      "table:public.leads",
    ]);
    expect(v.counts.tables).toBe(3);
  });

  it("folds the systems into parts, relations lifted, seams with their code on both ends", async () => {
    const sys = (id: string, extra: Partial<Node> = {}): Node => ({
      id: `system:${id}`,
      role: extra.parent ? "part" : "system",
      group: id.split(".")[0] as string,
      attrs: { kind: "app", title: id },
      ...extra,
    });
    const systems: Graph = {
      layer: "systems",
      nodes: [
        sys("app"),
        sys("app.api", {
          parent: "system:app",
          attrs: { kind: "app", title: "API", code: ["packages/a"] },
        }),
        sys("app.db", { parent: "system:app" }),
        sys("site"),
      ],
      edges: [
        { from: "system:app.api", to: "system:app.db", kind: "calls" },
        {
          from: "system:app.api",
          to: "system:site",
          kind: "calls",
          attrs: { title: ["clicks"], here: ["packages/a/src/x.ts"] },
        },
      ],
    };
    const v = await buildView({
      root: "/r",
      current: { imports: imports(), api, systems },
      approved: { imports: null, api: null, systems: null },
    });
    expect(v.nodes["repo:r"]?.kids).toEqual(["dir:apps", "dir:packages", "sys:"]);
    expect(v.nodes["sys:"]?.kids).toEqual(["system:app", "system:site"]);
    expect(v.nodes["system:app"]?.sub).toBe("2 parts");
    const at = (lvl: string) => v.levels[lvl]?.edges.map((e) => [e.from, e.to]) ?? [];
    expect(at("system:app")).toEqual([["system:app.api", "system:app.db"]]);
    expect(at("sys:")).toEqual([["system:app", "system:site"]]);
    expect(v.details["system:app.api"]?.code).toEqual([{ path: "packages/a", box: "@s/a" }]);
    expect(v.details["system:site"]?.seams).toEqual([
      {
        id: "system:app.api",
        out: false,
        kind: "calls",
        titles: ["clicks"],
        here: [{ path: "packages/a/src/x.ts", box: "@s/a/src/x.ts" }],
      },
    ]);
    expect(v.counts.systems).toBe(2);
  });

  it("folds the screens into apps and pages in tab order, each page and story on its file", async () => {
    const ui = fromDump(
      {
        areas: { team: [{ id: "tools", label: "Tools", apps: ["cal"] }], client: [] },
        apps: [
          {
            id: "cal",
            export: "clientCal",
            name: "Calendar",
            pages: [
              { id: "week", label: "Week", template: "hand", file: "packages/a/src/x.ts" },
              { id: "all", label: "All", template: "list", record: "booking" },
            ],
          },
          { id: "cal", export: "cal", audience: "team", name: "Calendar", pages: [] },
        ],
      },
      [{ id: "x", title: "Parts/X", file: "packages/b/src/z.ts", shows: ["packages/a/src/x.ts"] }],
    );
    const v = await buildView({
      root: "/r",
      current: { imports: imports(), api, ui },
      approved: { imports: null, api: null, ui: null },
    });
    expect(v.nodes["ui:"]?.kids).toEqual(["ui:clientCal", "ui:cal"]);
    expect(v.nodes["ui:clientCal"]).toMatchObject({ label: "Calendar · client", sub: "2 pages" });
    expect(v.nodes["ui:cal"]?.label).toBe("Calendar · Wren");
    expect(v.details["ui:cal"]?.attrs?.areas).toEqual(["team: Tools"]);
    expect(v.details["ui:clientCal"]?.attrs?.areas).toBeUndefined();
    // Tab order, not id order; a level with no lines keeps it in a grid.
    expect(v.nodes["ui:clientCal"]?.kids).toEqual(["ui:clientCal/week", "ui:clientCal/all"]);
    expect(v.levels["ui:clientCal"]?.grid).toBe(true);
    expect(v.nodes["ui:clientCal/all"]?.sub).toBe("list of booking");
    expect(v.details["ui:clientCal/week"]?.code).toEqual([
      { path: "packages/a/src/x.ts", box: "@s/a/src/x.ts" },
    ]);
    expect(v.details["@s/a/src/x.ts"]).toMatchObject({
      screens: ["ui:clientCal/week"],
      stories: [
        { id: "story:x", title: "Parts/X", file: "packages/b/src/z.ts", box: "@s/b/src/z.ts" },
      ],
    });
    expect(v.counts.screens).toBe(2);
  });
});

describe("slices", () => {
  const g = (layer: string, nodes: Graph["nodes"], edges: Graph["edges"]): Graph => ({
    layer,
    nodes,
    edges,
  });
  const screen = (id: string, attrs = {}): Node => ({ id, role: "screen", group: "a", attrs });
  const ui = g(
    "ui",
    [
      screen("ui:a/one"),
      ...["two", "three", "four"].map((x) => screen(`ui:a/${x}`)),
      screen("ui:a/rec", { record: "r" }),
    ],
    [
      {
        from: "ui:a/one",
        to: "route:Pay/charge",
        kind: "calls",
        attrs: { at: ["one.tsx"], path: "pay/charge" },
      },
      { from: "story:p", to: "ui:a/one", kind: "renders", attrs: { stories: ["p--one"] } },
      ...["two", "three", "four"].map((x) => ({
        from: `ui:a/${x}`,
        to: "route:Pay/list",
        kind: "calls",
      })),
      { from: "ui:a/rec", to: "table:public.r_view", kind: "reads" },
    ],
  );
  const routes = g(
    "routes",
    [
      {
        id: "route:Pay/charge",
        role: "route",
        group: "p",
        attrs: { npm: ["stripe", "yaml"], hosts: ["api.x.com"] },
      },
      { id: "route:Pay/list", role: "route", group: "p" },
    ],
    [
      { from: "route:Pay/charge", to: "table:public.clients", kind: "reads" },
      { from: "route:Pay/charge", to: "table:public.charges", kind: "reads" },
      { from: "route:Pay/charge", to: "table:public.charges", kind: "writes" },
      { from: "route:Pay/list", to: "table:public.clients", kind: "reads" },
    ],
  );
  const systems = g(
    "systems",
    [],
    [
      {
        from: "route:Pay/charge",
        to: "system:stripe",
        kind: "uses",
        attrs: { title: ["npm `stripe`"] },
      },
    ],
  );
  const out = slices({ ui, routes, systems }, (id) =>
    id.startsWith("route:") ? "file:pay.ts" : undefined,
  );

  it("gives a screen its calls, the tables behind them and what they reach outside", () => {
    const one = out.get("ui:a/one");
    expect(one?.calls).toEqual([
      {
        id: "route:Pay/charge",
        name: "Pay/charge",
        box: "file:pay.ts",
        at: ["one.tsx"],
        path: "pay/charge",
      },
    ]);
    expect(one?.stories).toEqual(["p--one"]);
    expect(one?.tables.map((t) => [t.label, t.kind, !!t.shared])).toEqual([
      ["public.charges", "writes", false],
      ["public.clients", "reads", true],
    ]);
    expect(one?.outside.map((o) => o.id)).toEqual(["host:api.x.com", "npm:yaml", "system:stripe"]);
  });

  it("gives a record screen its own view, never counted as shared", () => {
    expect(out.get("ui:a/rec")?.tables).toEqual([
      { id: "table:public.r_view", label: "public.r_view", kind: "reads", via: ["ui:a/rec"] },
    ]);
  });
});
