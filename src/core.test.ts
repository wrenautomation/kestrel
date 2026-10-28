import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diff, formatChanges } from "./diff.js";
import { byGroup, type Graph, normalize } from "./graph.js";
import { fileStore } from "./store.js";

const g = (over: Partial<Graph> = {}): Graph => ({
  layer: "imports",
  nodes: [
    { id: "@a/x", role: "package", group: "@a/x" },
    { id: "@a/x/src/i.ts", role: "file", parent: "@a/x", group: "@a/x" },
    { id: "@a/y", role: "package", group: "@a/y", attrs: { npm: ["zod", "commander"] } },
  ],
  edges: [{ from: "@a/x", to: "@a/y", kind: "imports" }],
  ...over,
});

describe("graph", () => {
  it("normalize gives the same bytes for the same graph in any order", () => {
    const a = g();
    const b = g({ nodes: [...a.nodes].reverse(), edges: [...a.edges, ...a.edges] });
    expect(JSON.stringify(normalize(b))).toBe(JSON.stringify(normalize(a)));
    expect(normalize(a).nodes[2]?.attrs?.npm).toEqual(["commander", "zod"]);
  });

  it("byGroup puts an edge with its from node", () => {
    const parts = byGroup(g());
    expect([...parts.keys()]).toEqual(["@a/x", "@a/y"]);
    expect(parts.get("@a/x")?.edges).toHaveLength(1);
  });
});

describe("diff", () => {
  it("is empty for the same graph", () => {
    expect(diff(g(), g())).toEqual([]);
  });

  it("names adds, removes and changed keys", () => {
    const cur = g();
    cur.nodes = cur.nodes.filter((n) => n.id !== "@a/x/src/i.ts");
    cur.nodes.push({ id: "@a/x/src/j.ts", role: "file", parent: "@a/x", group: "@a/x" });
    cur.edges = [{ from: "@a/x", to: "@a/y", kind: "imports", attrs: { type: true } }];
    const changes = diff(g(), cur);
    expect(changes.map((c) => `${c.op} ${c.id}`)).toEqual([
      "change @a/x -imports-> @a/y",
      "remove @a/x/src/i.ts",
      "add @a/x/src/j.ts",
    ]);
    expect(formatChanges(changes)).toContain("~ edge @a/x -imports-> @a/y (attrs.type)");
  });
});

describe("store", () => {
  let root = "";
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("round-trips, removes gone groups, and approves the whole layer", async () => {
    root = await mkdtemp(join(tmpdir(), "kestrel-"));
    const store = fileStore(root, "map/generated");
    await store.write("imports", "current", g());
    expect(await store.read("imports", "current")).toEqual(normalize(g()));
    expect(await store.approve("imports")).toEqual(["@a/x", "@a/y"]);
    expect(await store.approve("imports")).toEqual([]);

    const smaller = g({ nodes: g().nodes.filter((n) => n.group === "@a/x") });
    await store.write("imports", "current", smaller);
    const files = await readdir(join(root, "map/generated/imports"));
    expect(files.filter((f) => f.endsWith(".current.json"))).toEqual(["@a+x.current.json"]);
    expect(await store.approve("imports")).toEqual(["@a/y"]);
  });
});
