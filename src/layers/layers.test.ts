import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Config } from "../config.js";
import { api } from "./api.js";
import { routes } from "./routes.js";

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
