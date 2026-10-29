import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Config } from "../config.js";
import type { Graph } from "../graph.js";
import { api } from "./api.js";
import { routes } from "./routes.js";
import { fromTbls, schema } from "./schema.js";
import { seams, systems } from "./systems.js";
import { readStory, screenCalls } from "./ui.js";
import { headerLine } from "./workspace.js";

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
      { from: "ui:a/one", to: "route:Accounts/list", kind: "calls", attrs: { at: ["hook.ts"] } },
      { from: "ui:a/two", to: "route:Accounts/list", kind: "calls", attrs: { at: ["s2.tsx"] } },
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
