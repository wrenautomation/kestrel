import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Project, SyntaxKind } from "ts-morph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Config } from "../config.js";
import type { Graph, Node } from "../graph.js";
import { api } from "./api.js";
import { reader } from "./reach.js";
import { routes } from "./routes.js";
import { fromTbls, schema } from "./schema.js";
import { factoryLinks, routeLinks, seams, systems } from "./systems.js";
import { pageEdges, readStory, recordReads, recordTables, screenCalls } from "./ui.js";
import { headerLine, lockVersions } from "./workspace.js";

const FILES: Record<string, string> = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext" } }),
  "packages/a/package.json": JSON.stringify({
    name: "@x/a",
    exports: { ".": "./src/index.ts", "./more": "./src/more.ts" },
  }),
  "packages/a/src/index.ts": `
/** Doc comments are not shape. */
export function send(to: string, body: string): Promise<{ id: string }> { return Promise.resolve({ id: to + body }); }
export interface Lead { id: string; // why
  email: string }
export const inferred = () => ({ n: 1 });
export * from "./more.js";
`,
  "packages/a/src/more.ts": "export type Mode = 'a' | 'b';\n",
  "packages/a/src/db.ts": `
declare const pgTable: any; declare const pgSchema: any;
export const leads = pgTable("leads", {});
const auth = pgSchema("auth");
export const users = auth.table("user", {});
export const gone = pgTable("not_in_schema", {});
`,
  "packages/a/src/store.ts": `
import { leads, users } from "./db.js";
declare const db: any; declare const sql: any;
export function store() {
  return {
    list: () => db.select().from(leads),
    add: (id: string) => db.insert(leads).values({ id }),
    who: () => db.execute(sql\`select * from auth."user" u join leads l on true where u.id = \${1}\`),
    log: () => db.execute(sql\`insert into events (x) values (1)\`),
  };
}
export const touch = () => users;
`,
  "packages/a/src/desk.ts": `
declare const restate: any; declare function wrap(f: unknown): unknown;
import { store, touch } from "./store.js";
const api = store();
export const desk = restate.service({
  name: "Desk",
  handlers: {
    list: async (ctx: unknown) => api.list(),
    add: async (ctx: unknown, id: string) => { await api.add(id); return api.list(); },
    who: async (ctx: unknown) => api.who(),
    log: async (ctx: unknown) => { api.log(); touch(); },
    wrapped: wrap(api.add),
    ping: async (ctx: unknown) => [fetch(\`https://api.example.com/v1/\${1}\`), "https://page.example.com/in/x"],
  },
});
`,
  "packages/a/src/far.ts":
    "export const far = () => ({ away: async (ctx: unknown): Promise<string> => 'x' });\n",
  "packages/a/src/restate.ts": `
declare const restate: any; declare const serviceHandler: any; declare const portalService: any;
import { far } from "./far.js";
interface In { id: string } interface Out { ok: boolean }
const NAME = "Mail";
export const svc = restate.service({
  name: NAME,
  handlers: {
    send: serviceHandler({}, async (ctx: unknown, req: In): Promise<Out> => ({ ok: !!req })),
    ping: async (ctx: unknown): Promise<string> => "pong",
  },
});
export const acct = portalService({
  name: "Accounts",
  main: 1,
  handlers: {
    list: serviceHandler({}, async (ctx: unknown, req: In): Promise<Out> => ({ ok: !!req })),
    ...more(),
    ...MORE,
    ...far(),
  },
});
function more() {
  return { pick: async (ctx: unknown, req: In): Promise<Out> => ({ ok: !!req }) };
}
const MORE = { drop: async (ctx: unknown): Promise<string> => "x" };
export const notOne = make({ name: "x", handlers: 1 });
declare function make(o: unknown): unknown;
`,
};

let root = "";
const ctx = () => ({
  root,
  config: Config.parse({ layers: { api: {}, routes: {} } }),
  env: {},
  prior: async () => null,
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kestrel-layers-"));
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe("api", () => {
  it("gives one node per export, with entries, signature and no comments", async () => {
    const g = await api.extract(ctx());
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n.attrs]));
    expect(Object.keys(byId).sort()).toEqual([
      "@x/a#Lead",
      "@x/a#Mode",
      "@x/a#inferred",
      "@x/a#send",
    ]);
    expect(byId["@x/a#send"]?.sig).toBe("(to: string, body: string): Promise<{ id: string }>");
    expect(byId["@x/a#Lead"]?.sig).toBe("interface Lead { id: string; email: string }");
    expect(byId["@x/a#Mode"]?.entries).toEqual(["@x/a", "@x/a/more"]);
    expect(byId["@x/a#inferred"]?.inferred).toBe(true);
    expect(byId["@x/a#send"]?.inferred).toBeUndefined();
  });
});

describe("routes", () => {
  it("links each handler to the tables it reaches: drizzle names and SQL text, reads and writes", async () => {
    const schema: Graph = {
      layer: "schema",
      nodes: ["public.leads", "auth.user", "public.events"].map((t) => ({
        id: `table:${t}`,
        role: "table" as const,
        group: "x",
      })),
      edges: [],
    };
    const g = await routes.extract({
      ...ctx(),
      prior: async (l) => (l === "schema" ? schema : null),
    });
    const of = (r: string) =>
      g.edges.filter((e) => e.from === `route:Desk/${r}`).map((e) => `${e.kind} ${e.to}`);
    expect(of("list")).toEqual(["reads table:public.leads"]);
    expect(of("add")).toEqual(["writes table:public.leads"]);
    expect(of("who")).toEqual(["reads table:auth.user", "reads table:public.leads"]);
    expect(of("wrapped")).toEqual(["writes table:public.leads"]);
    expect(g.nodes.find((n) => n.id === "route:Desk/ping")?.attrs?.hosts).toEqual([
      "api.example.com",
    ]);
    expect(of("log")).toEqual(["reads table:auth.user", "writes table:public.events"]);
  });

  it("reads the service name through a const, each handler's input and output, and a wrapper", async () => {
    const g = await routes.extract(ctx());
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(byId["service:Mail"]?.parent).toBe("@x/a");
    expect(byId["route:Mail/send"]?.attrs).toMatchObject({
      input: "In",
      output: "Out",
      wrap: "serviceHandler",
    });
    expect(byId["route:Mail/ping"]?.attrs).toMatchObject({
      input: "void",
      output: "string",
      wrap: "plain",
    });
    expect(byId["service:Accounts"]?.attrs).toMatchObject({
      kind: "service",
      via: "portalService",
    });
    expect(byId["route:Accounts/list"]?.attrs).toMatchObject({ input: "In", output: "Out" });
    // spread handlers: a function's returned object, a const's
    expect(byId["route:Accounts/pick"]?.attrs).toMatchObject({ input: "In", output: "Out" });
    expect(byId["route:Accounts/away"]).toBeDefined();
    expect(byId["route:Accounts/drop"]?.attrs).toMatchObject({ input: "void", output: "string" });
    expect(byId["service:x"]).toBeUndefined();
  });
});

describe("schema", () => {
  it("gives tables under their schema, indexes under tables and a key per foreign key", () => {
    const g = fromTbls(
      {
        tables: [
          {
            name: "public.leads",
            type: "BASE TABLE",
            columns: [
              { name: "id", type: "uuid", nullable: false, default: "gen_random_uuid()" },
              { name: "client_id", type: "uuid", nullable: true },
            ],
            indexes: [{ name: "leads_pkey", def: "CREATE UNIQUE INDEX leads_pkey ON leads (id)" }],
            constraints: [{ name: "leads_pkey", type: "PRIMARY KEY", def: "PRIMARY KEY (id)" }],
          },
          {
            name: "clients",
            type: "VIEW",
            columns: [{ name: "id", type: "uuid", nullable: false }],
          },
          { name: "audit.log", type: "BASE TABLE", columns: [] },
        ],
        relations: [
          {
            table: "public.leads",
            columns: ["client_id"],
            parent_table: "clients",
            parent_columns: ["id"],
          },
          {
            table: "public.leads",
            columns: ["owner_id"],
            parent_table: "clients",
            parent_columns: ["id"],
          },
        ],
      },
      { skip: ["audit"] },
      ["0001_init.sql"],
    );
    expect(g.nodes.map((n) => [n.id, n.role, n.parent ?? null])).toEqual([
      ["schema:public", "schema", null],
      ["table:public.leads", "table", "schema:public"],
      ["index:public.leads.leads_pkey", "index", "table:public.leads"],
      ["table:public.clients", "table", "schema:public"],
      ["migration:0001_init.sql", "migration", null],
    ]);
    expect(g.nodes[1]?.attrs?.columns).toEqual([
      "id uuid = gen_random_uuid()",
      "client_id uuid null",
    ]);
    expect(g.nodes[3]?.attrs?.kind).toBe("view");
    expect(g.edges).toEqual([
      {
        from: "table:public.leads",
        to: "table:public.clients",
        kind: "references",
        attrs: { columns: ["client_id → id", "owner_id → id"] },
      },
    ]);
    const pages = schema.render({ ...g, nodes: g.nodes.filter((n) => n.group === "public") });
    expect(pages["public.md"]).toContain("- public.clients (client_id → id; owner_id → id)");
  });
});

describe("systems", () => {
  it("derives units from deploy files and links from what their bundles name", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "kestrel-sys-")), "app");
    const put = async (p: string, t: string) => {
      await mkdir(dirname(join(root, p)), { recursive: true });
      await writeFile(join(root, p), t);
    };
    await put("package.json", JSON.stringify({ name: "app", description: "Sends mail" }));
    await put("apps/web/package.json", JSON.stringify({ name: "@a/web", description: "The site" }));
    await put(
      "apps/web/wrangler.toml",
      'name = "app-web"\nmain = "src/index.ts"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "hits"\n',
    );
    await put("apps/web/src/index.ts", 'import { send } from "./send.js";\n');
    await put(
      "apps/web/src/send.ts",
      'import Stripe from "stripe";\nconst u = settings.mailUrl;\n',
    );
    await put(
      "deploy/main.tf",
      '# The box. Runs the cache.\nresource "aws_instance" "box" {\n  instance_type = "t4g.small"\n}\n',
    );
    await put(
      "deploy/box-cache.sh",
      "# @unit cache: Valkey for the admin reads\ndocker run valkey\n",
    );
    await put("deploy/box-other.sh", "docker run other\n");
    await put("config.ts", 'mailUrl: "APP_MAIL_URL",\n');
    await put("../mail/package.json", JSON.stringify({ name: "@m/mail", description: "Mail out" }));
    const imports: Graph = {
      layer: "imports",
      nodes: [
        { id: "@a/web", role: "package", group: "@a/web", attrs: { dir: "apps/web/" } },
        { id: "@a/web/src/index.ts", role: "file", parent: "@a/web", group: "@a/web" },
        { id: "@a/web/src/send.ts", role: "file", parent: "@a/web", group: "@a/web" },
      ],
      edges: [{ from: "@a/web/src/index.ts", to: "@a/web/src/send.ts", kind: "imports" }],
    };
    const config = Config.parse({
      layers: {
        systems: {
          terraform: ["deploy/*.tf"],
          tags: ["deploy/*.sh"],
          hosts: { "deploy/box-*.sh": "host:box" },
          repos: { mail: "../mail" },
          vendors: { stripe: { title: "Stripe" } },
          imports: { stripe: "stripe" },
          env: { APP_MAIL_URL: "mail" },
          settings: { file: "config.ts", pattern: '(\\w+): "(APP_\\w+)"' },
        },
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = await systems.extract({
      root,
      config,
      env: {},
      prior: async (l) => (l === "imports" ? imports : null),
    });
    expect(warn.mock.calls.map((c) => c[0])).toContain(
      "systems: deploy/box-other.sh starts a process and has no `# @unit name: one line`",
    );
    warn.mockRestore();
    expect(g.nodes.map((n) => [n.id, n.parent ?? null, n.attrs?.description ?? null])).toEqual([
      ["system:app", null, "Sends mail"],
      ["system:mail", null, "Mail out"],
      ["system:stripe", null, null],
      ["system:app.worker:web", "system:app", "The site"],
      ["system:app.d1:hits", "system:app", null],
      ["system:app.host:box", "system:app", "The box"],
      ["system:app.container:cache", "system:app.host:box", "Valkey for the admin reads"],
    ]);
    const send = "apps/web/src/send.ts";
    expect(g.edges.map((e) => [e.from, e.kind, e.to, e.attrs?.title, e.attrs?.here])).toEqual([
      [
        "system:app.worker:web",
        "binds",
        "system:app.d1:hits",
        ["binding `hits`"],
        ["apps/web/wrangler.toml"],
      ],
      ["system:app.worker:web", "calls", "system:mail", ["`APP_MAIL_URL`"], [send]],
      ["system:app.worker:web", "uses", "system:stripe", ["`stripe`"], [send]],
    ]);
    expect(await seams(root, g)).toEqual([]);
    const [s] =
      (await systems.sections?.({
        root,
        config,
        env: {},
        prior: async (l) => (l === "imports" ? imports : null),
      })) ?? [];
    expect(s?.files).toEqual([
      "../mail/package.json",
      "apps/web/package.json",
      "apps/web/src/index.ts",
      send,
      "apps/web/wrangler.toml",
      "config.ts",
      "deploy/box-cache.sh",
      "deploy/box-other.sh",
      "deploy/main.tf",
      "package.json",
    ]);
    await rm(dirname(root), { recursive: true });
  }, 30_000);
});

describe("ui", () => {
  it("reads a story's meta through a named default and drops mocks from what it shows", async () => {
    const at = (p: string) => join(root, p);
    await mkdir(at("app/src/mocks"), { recursive: true });
    for (const f of ["app/src/card.tsx", "app/src/mocks/api.ts"]) await writeFile(at(f), "");
    const text = `import { Card } from "./card.js";
import { api } from "./mocks/api.js";
import type { Meta } from "@storybook/react";
const meta: Meta = { title: "Parts/Card", id: "parts-card" };
export default meta;
export const One = { args: { id: "n1" } };
`;
    expect(readStory(root, "app/src/card.stories.tsx", text)).toEqual({
      file: "app/src/card.stories.tsx",
      id: "parts-card",
      title: "Parts/Card",
      shows: ["app/src/card.tsx"],
    });
    expect(readStory(root, "app/src/bare.stories.tsx", "export default {};\n")).toMatchObject({
      id: "bare",
      title: "bare",
    });
  });

  it("reads page stories as Storybook ids and links each to the screen its address opens", () => {
    const text = `const meta: Meta = { title: "Revamp/Learn", id: "pages-learn" };
export default meta;
export const Today = pageAt("/learn/today", {
  me: ADMIN,
});
export const SourcesPickTwoFast: StoryObj = pageAt("/learn/sources?x=1", { me: ADMIN });
export const Home = pageAt("/learn");
export const Person = pageAt("/learn/people/42", { me: ADMIN });
export const Gone = pageAt("/nowhere");
export const Plain = { args: {} };
`;
    const story = readStory(root, "app/src/pages-learn.stories.tsx", text, "pageAt", /me: ADMIN/);
    expect(story.pages).toEqual([
      { id: "pages-learn--today", at: "/learn/today", team: true },
      { id: "pages-learn--sources-pick-two-fast", at: "/learn/sources?x=1", team: true },
      { id: "pages-learn--home", at: "/learn" },
      { id: "pages-learn--person", at: "/learn/people/42", team: true },
      { id: "pages-learn--gone", at: "/nowhere" },
    ]);
    // two apps at /learn: the team's (`ui:learn`) and a client's (`ui:clientLearn`)
    const app = (id: string, workspace: string): Node => ({
      id,
      role: "app",
      group: "learn",
      attrs: { path: "/learn", workspace },
    });
    const page = (id: string, order: number, parent = "ui:learn"): Node => ({
      id,
      role: "screen",
      parent,
      group: "learn",
      attrs: { order },
    });
    const nodes = [
      app("ui:clientLearn", "client"),
      app("ui:learn", "wren"),
      page("ui:clientLearn/today", 0, "ui:clientLearn"),
      page("ui:learn/today", 1),
      page("ui:learn/home", 0),
      page("ui:learn/sources", 2),
      page("ui:learn/people", 3),
    ];
    // unsplit: the first app at an address wins
    expect(pageEdges(nodes, [story]).map((e) => e.to)).toEqual([
      "ui:clientLearn/today",
      "ui:learn/sources",
      "ui:learn/people",
    ]);
    expect(pageEdges(nodes, [story], true)).toEqual([
      {
        from: "story:pages-learn",
        to: "ui:learn/today",
        kind: "renders",
        attrs: { stories: ["pages-learn--today"] },
      },
      {
        from: "story:pages-learn",
        to: "ui:learn/sources",
        kind: "renders",
        attrs: { stories: ["pages-learn--sources-pick-two-fast"] },
      },
      {
        from: "story:pages-learn",
        to: "ui:clientLearn/today",
        kind: "renders",
        attrs: { stories: ["pages-learn--home"] },
      },
      {
        from: "story:pages-learn",
        to: "ui:learn/people",
        kind: "renders",
        attrs: { stories: ["pages-learn--person"] },
      },
    ]);
  });
});

describe("screenCalls", () => {
  const routes: Graph = {
    layer: "routes",
    nodes: [
      { id: "service:Accounts", role: "service", group: "a" },
      { id: "route:Accounts/list", role: "route", parent: "service:Accounts", group: "a" },
      { id: "service:Accounts@t.ts", role: "service", group: "a" },
      {
        id: "route:Accounts@t.ts/list",
        role: "route",
        parent: "service:Accounts@t.ts",
        group: "a",
      },
      { id: "service:Files", role: "service", group: "a" },
      { id: "route:Files/upload", role: "route", parent: "service:Files", group: "a" },
    ],
    edges: [],
  };
  // four screen files, all on the api client (shell); a hook only one reaches
  const reach: Record<string, string[]> = {
    "s1.tsx": ["s1.tsx", "api.ts", "hook.ts"],
    "s2.tsx": ["s2.tsx", "api.ts"],
    "s3.tsx": ["s3.tsx", "api.ts"],
    "s4.tsx": ["s4.tsx", "api.ts"],
  };
  const text: Record<string, string> = {
    "api.ts": 'export const up = () => call("files/upload", {});',
    "hook.ts": 'call<{ rows: Row[] }>("accounts/list")',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a built path, not a literal
    "s1.tsx": 'post("accounts/gone"); call(`x/${y}`); other("accounts/list")',
    "s2.tsx": 'call("accounts/list"); call("accounts/list")',
    "s3.tsx": 'callAsMe<Omit<A, "b">>(\n  "nope/list")',
  };
  const out = screenCalls({
    screens: [
      { id: "ui:a/one", file: "s1.tsx" },
      { id: "ui:a/two", file: "s2.tsx" },
      { id: "ui:a/three", file: "s3.tsx" },
      { id: "ui:a/four", file: "s4.tsx" },
      { id: "ui:a/lost", file: "none.tsx" },
    ],
    reach: (f) => (reach[f] ? new Set(reach[f]) : undefined),
    text: (f) => text[f] ?? "",
    api: { accounts: "Accounts", files: "Files" },
    routes,
    fns: ["call", "callAsMe", "post"],
  });
  it("links a screen to the routes its files call, the plain service first", () => {
    expect(out.edges).toEqual([
      {
        from: "ui:a/one",
        to: "route:Accounts/list",
        kind: "calls",
        attrs: { at: ["hook.ts"], path: "accounts/list" },
      },
      {
        from: "ui:a/two",
        to: "route:Accounts/list",
        kind: "calls",
        attrs: { at: ["s2.tsx"], path: "accounts/list" },
      },
    ]);
  });
  it("leaves out shell calls and lists literals no route matches", () => {
    expect(Object.fromEntries(out.lost)).toEqual({
      "ui:a/one": { missing: ["accounts/gone"] },
      "ui:a/three": { host: ["nope/list"] },
    });
  });
});

describe("headerLine", () => {
  it("takes the first sentence of the top doc comment", () => {
    expect(headerLine("/**\n * Reads mail. Then more.\n * @see x\n */\nexport const a = 1;")).toBe(
      "Reads mail",
    );
    expect(headerLine("#!/usr/bin/env node\n/** The CLI. */")).toBe("The CLI");
    expect(headerLine("/** Email sequences (designs/2026-10-04-x.md, O2): its mailboxes. */")).toBe(
      "Email sequences: its mailboxes",
    );
  });
  it("skips a doc comment that is not at the top", () => {
    expect(headerLine('import x from "x";\n/** A. */\nexport const a = 1;')).toBeUndefined();
  });
});

describe("systems routeLinks", () => {
  it("gives a uses edge from a route to each package the import map names", () => {
    const routes: Graph = {
      layer: "routes",
      nodes: [
        { id: "route:Pay/charge", role: "route", group: "pay", attrs: { npm: ["stripe", "yaml"] } },
        { id: "route:Pay/list", role: "route", group: "pay", attrs: {} },
      ],
      edges: [],
    };
    expect(routeLinks(routes, { stripe: "stripe", "@acme": "acme" })).toEqual([
      { from: "route:Pay/charge", to: "stripe", kind: "uses", title: "npm `stripe`" },
    ]);
  });
});

describe("record screens", () => {
  it("read their kind's views and what its rows reach, a const id through the checker", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "/r.ts",
      `declare function defineRecord(d: object): object;
const DAY = "health.day";
defineRecord({ id: DAY, view: "delivery.days", activity: { view: "day_events" } });
defineRecord({ id: "health.rows", rows: (db: { query(s: string): unknown }) => db.query("select * from public.scores") });
defineRecord({ id: "health.none", rows: () => [] });`,
    );
    const tables = new Set([
      "table:delivery.days",
      "table:public.day_events",
      "table:public.scores",
    ]);
    const kinds = recordTables(project, "defineRecord", tables);
    expect([...kinds]).toEqual([
      ["health.day", ["table:delivery.days", "table:public.day_events"]],
      ["health.rows", ["table:public.scores"]],
    ]);
    const nodes: Graph["nodes"] = [
      { id: "ui:h/day", role: "screen", group: "h", attrs: { record: "health.day" } },
      { id: "ui:h/rows", role: "screen", group: "h", attrs: { record: "health.rows" } },
    ];
    expect(recordReads(nodes, kinds)).toEqual([
      { from: "ui:h/day", to: "table:delivery.days", kind: "reads" },
      { from: "ui:h/day", to: "table:public.day_events", kind: "reads" },
      { from: "ui:h/rows", to: "table:public.scores", kind: "reads" },
    ]);
  });
});

describe("record screens, more", () => {
  it("read a key in a spread, rows by name, and what rows reach outside", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "/r.ts",
      `declare function defineRecord(d: object): object;
const BASE = { id: "sites.form" } as const;
const rows = (db: { query(s: string): unknown }) => db.query("select * from forms");
defineRecord({ ...BASE, rows });
const steps = () => fetch("https://site.example/api/export");
defineRecord({ id: "marketing.session", rows: steps });`,
    );
    const outside = new Map<string, { hosts: string[]; npm: string[] }>();
    const kinds = recordTables(project, "defineRecord", new Set(["table:public.forms"]), outside);
    expect([...kinds]).toEqual([["sites.form", ["table:public.forms"]]]);
    expect([...outside]).toEqual([["marketing.session", { hosts: ["site.example"], npm: [] }]]);
  });
});

describe("reach", () => {
  it("follows a literal into the property a body picks with it, and notes deps fields", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const f = project.createSourceFile(
      "/n.ts",
      `type Db = { query(s: string): unknown };
function notesApi(deps: { db: Db; files: string }) {
  return {
    home: () => deps.db.query("select * from notes"),
    file: () => deps.files,
  };
}
export function make(deps: { db: Db; files: string }) {
  const api = notesApi(deps);
  const read = (route: "home" | "file") => () => api[route]();
  return { home: read("home"), file: read("file") };
}`,
    );
    const read = reader(project, new Set(["table:public.notes"]), new Set(["db", "files"]));
    const obj = f
      .getFunctionOrThrow("make")
      .getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)[0];
    const at = (k: string) =>
      obj
        ?.getPropertyOrThrow(k)
        .asKindOrThrow(SyntaxKind.PropertyAssignment)
        .getInitializerOrThrow();
    const home = read(at("home") as never);
    expect([...home.tables.keys()]).toEqual(["table:public.notes"]);
    expect([...read(at("file") as never).deps]).toContain("files");
  });
});

describe("home stories", () => {
  it("open the root app at `/` and nothing else falls back to it", () => {
    const nodes: Node[] = [
      { id: "ui:wrenHome", role: "app", group: "h", attrs: { path: "/", workspace: "wren" } },
      { id: "ui:clientHome", role: "app", group: "c", attrs: { path: "/", workspace: "client" } },
      {
        id: "ui:wrenHome/today",
        role: "screen",
        parent: "ui:wrenHome",
        group: "h",
        attrs: { order: 0 },
      },
      {
        id: "ui:clientHome/today",
        role: "screen",
        parent: "ui:clientHome",
        group: "c",
        attrs: { order: 0 },
      },
    ];
    const story = {
      file: "s.tsx",
      id: "pages",
      title: "Pages",
      shows: [],
      pages: [
        { id: "pages--today", at: "/", team: true as const },
        { id: "pages--client", at: "/?x=1" },
        { id: "pages--gone", at: "/nowhere" },
      ],
    };
    expect(pageEdges(nodes, [story], true).map((e) => [e.to, e.attrs?.stories])).toEqual([
      ["ui:wrenHome/today", ["pages--today"]],
      ["ui:clientHome/today", ["pages--client"]],
    ]);
  });
});

describe("systems factoryLinks", () => {
  it("hands an env var to the routes that read the deps field naming it", () => {
    const routes: Graph = {
      layer: "routes",
      nodes: [
        { id: "service:Notes", role: "service", group: "n", attrs: { factory: "makeNotes" } },
        {
          id: "route:Notes/file",
          role: "route",
          parent: "service:Notes",
          group: "n",
          attrs: { deps: ["files"] },
        },
        {
          id: "route:Notes/home",
          role: "route",
          parent: "service:Notes",
          group: "n",
          attrs: { deps: ["db"] },
        },
      ],
      edges: [],
    };
    const files = new Map([
      [
        "deps.ts",
        "const notesDeps = {\n  db,\n  // the bucket\n  files: settings.filesBucket ? s3({ b: 1 }) : undefined,\n};",
      ],
      ["apps.ts", "export function makeNotes(d) {}\nconst all = [makeNotes(notesDeps)];"],
    ]);
    const facts = {
      env: { WREN_FILES_BUCKET: "s3:files" },
      aliases: { filesBucket: "WREN_FILES_BUCKET" },
      imports: {},
    };
    expect(factoryLinks(routes, files, facts)).toEqual([
      {
        from: "route:Notes/file",
        to: "s3:files",
        kind: "calls",
        title: "`WREN_FILES_BUCKET`",
        here: "apps.ts",
      },
    ]);
  });
});

describe("lockVersions", () => {
  it("reads each importer's resolved versions, no links, no peer suffix", async () => {
    const root = await mkdtemp(join(tmpdir(), "kestrel-lock-"));
    await writeFile(
      join(root, "pnpm-lock.yaml"),
      [
        "lockfileVersion: '9.0'",
        "importers:",
        "  packages/a:",
        "    dependencies:",
        "      react-dom:",
        "        specifier: 19.0.0",
        "        version: 19.0.0(react@19.0.0)",
        "      '@x/b':",
        "        specifier: workspace:*",
        "        version: link:../b",
        "    devDependencies:",
        "      vitest:",
        "        specifier: 4.0.0",
        "        version: 4.0.0",
      ].join("\n"),
    );
    const v = await lockVersions(root);
    expect([...(v.get("packages/a/") ?? [])]).toEqual([
      ["react-dom", "19.0.0"],
      ["vitest", "4.0.0"],
    ]);
    await rm(root, { recursive: true, force: true });
  });
});
