import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cache, keysOf, type Section, WHOLE } from "./cache.js";
import type { Graph } from "./graph.js";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kestrel-cache-"));
  for (const f of ["a.ts", "b.ts", "c.ts"]) await writeFile(join(root, f), f);
});
afterAll(() => rm(root, { recursive: true, force: true }));

const SECTIONS: Section[] = [
  { group: "a", files: ["a.ts"] },
  { group: "b", files: ["b.ts"], deps: ["a"] },
  { group: "c", files: ["c.ts"], names: ["a.ts"] },
];

const graph = (groups: string[]): Graph => ({
  layer: "x",
  nodes: groups.map((g) => ({ id: g, role: "package", group: g })),
  edges: [],
});

describe("keysOf", () => {
  it("a change reaches the groups that depend on it, not those that only name its files", async () => {
    const before = await keysOf(root, SECTIONS, "s");
    await writeFile(join(root, "a.ts"), "a2");
    const after = await keysOf(root, SECTIONS, "s");
    expect(after.get("a")).not.toBe(before.get("a"));
    expect(after.get("b")).not.toBe(before.get("b"));
    expect(after.get("c")).toBe(before.get("c"));
  });

  it("a new salt is a new key", async () => {
    const [x, y] = await Promise.all([keysOf(root, SECTIONS, "s"), keysOf(root, SECTIONS, "t")]);
    expect(x.get("a")).not.toBe(y.get("a"));
  });

  it("a cycle ends", async () => {
    const loop: Section[] = [
      { group: "p", files: [], deps: ["q"] },
      { group: "q", files: [], deps: ["p"] },
    ];
    expect((await keysOf(root, loop, "s")).size).toBe(2);
  });
});

describe("plan", () => {
  it("runs only stale groups, and a group whose stored output changed", async () => {
    const c = cache(root);
    const keys = new Map([
      ["a", "1"],
      ["b", "1"],
    ]);
    const g = graph(["a", "b"]);
    expect((await c.plan("x", keys, null)).only).toEqual(new Set(["a", "b"]));
    await c.save("x", keys, g);
    expect((await c.plan("x", keys, g)).only?.size).toBe(0);
    expect((await c.plan("x", new Map([...keys, ["b", "2"]]), g)).only).toEqual(new Set(["b"]));
    const edited = graph(["a", "b"]);
    edited.nodes[0] = { id: "a", role: "file", group: "a" };
    expect((await c.plan("x", keys, edited)).only).toEqual(new Set(["a"]));
    expect((await c.plan("x", new Map([["a", "1"]]), g)).gone).toEqual(new Set(["b"]));
  });

  it("a whole layer runs whole or not at all", async () => {
    const c = cache(root);
    const keys = new Map([[WHOLE, "1"]]);
    const g = graph(["s"]);
    expect((await c.plan("w", keys, g)).only).toBeNull();
    await c.save("w", keys, g);
    expect((await c.plan("w", keys, g)).only?.size).toBe(0);
  });
});
