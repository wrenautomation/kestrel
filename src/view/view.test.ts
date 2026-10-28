import { describe, expect, it } from "vitest";
import type { Edge, Graph, Node } from "../graph.js";
import { buildView, GRID_OVER } from "./build.js";
import type { LayoutCache } from "./types.js";

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

const view = (current: Graph, approved: Graph | null = null, cache?: LayoutCache) =>
  buildView({
    root: "/r",
    current: { imports: current, api },
    approved: { imports: approved, api: approved ? api : null },
    ...(cache ? { cache } : {}),
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
    // Laid out: every box placed, every line routed.
    expect(v.levels["dir:packages"]?.boxes.every((b) => b.w > 0 && b.h > 0)).toBe(true);
    expect(v.levels["dir:packages"]?.edges[0]?.points.length).toBeGreaterThan(1);
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
    const top = lvl?.boxes.find((b) => b.x === 0 && b.y === 0);
    expect(top?.id).toBe("@s/b/src/f9.ts");
    expect(v.levels["@s/a"]?.grid).toBeUndefined();
  });

  it("reuses a cached layout and drops entries no level used", async () => {
    const cache: LayoutCache = { stale: { w: 0, h: 0, boxes: [], points: [] } };
    const a = await view(imports(), null, cache);
    expect(cache.stale).toBeUndefined();
    const keys = Object.keys(cache).sort();
    expect(keys).toHaveLength(Object.keys(a.levels).length);
    const b = await view(imports(), null, cache);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(Object.keys(cache).sort()).toEqual(keys);
  });
});
