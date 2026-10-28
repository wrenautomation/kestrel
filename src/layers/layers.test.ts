import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Config } from "../config.js";
import { api } from "./api.js";
import { routes } from "./routes.js";
import { fromTbls, schema } from "./schema.js";
import { seams, systems } from "./systems.js";
import { readStory } from "./ui.js";

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
  "packages/a/src/restate.ts": `
declare const restate: any; declare const serviceHandler: any;
interface In { id: string } interface Out { ok: boolean }
const NAME = "Mail";
export const svc = restate.service({
  name: NAME,
  handlers: {
    send: serviceHandler({}, async (ctx: unknown, req: In): Promise<Out> => ({ ok: !!req })),
    ping: async (ctx: unknown): Promise<string> => "pong",
  },
});
`,
};

let root = "";
const ctx = () => ({ root, config: Config.parse({ layers: { api: {}, routes: {} } }), env: {} });

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
  it("reads the service name through a const and each handler's input and output", async () => {
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
  it("reads a LikeC4 workspace into systems, services and calls, and finds gone code paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "kestrel-c4-"));
    await mkdir(join(root, "map/system"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/send.ts"), "");
    await writeFile(
      join(root, "map/system/model.c4"),
      `specification { element system  element service }
model {
  app = system 'App' {
    description 'Sends mail'
    worker = service 'Worker' { technology 'Lambda' }
  }
  mail = system 'Mail'
  app.worker -> mail 'send' { metadata { here 'src/send.ts'
    there '../mail/src/gone.ts' } }
  app.worker -> mail 'bounce'
}`,
    );
    const g = await systems.extract({
      root,
      config: Config.parse({ layers: { systems: {} } }),
      env: {},
    });
    expect(g.nodes.map((n) => [n.id, n.role, n.parent ?? null])).toEqual([
      ["system:app", "system", null],
      ["system:mail", "system", null],
      ["system:app.worker", "part", "system:app"],
    ]);
    expect(g.nodes[0]?.attrs).toMatchObject({ title: "App", description: "Sends mail" });
    expect(g.edges).toEqual([
      {
        from: "system:app.worker",
        to: "system:mail",
        kind: "calls",
        attrs: { title: ["send", "bounce"], here: ["src/send.ts"], there: ["../mail/src/gone.ts"] },
      },
    ]);
    expect(await seams(root, g)).toEqual(["system:app.worker → system:mail: ../mail/src/gone.ts"]);
    await rm(root, { recursive: true });
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
