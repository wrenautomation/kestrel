import { describe, expect, it } from "vitest";
import type { Edge, Graph, Node } from "./graph.js";
import { cycles, FLAT_OVER, fromGraphs, fromJscpd, fromKnip, page } from "./health.js";

const file = (id: string, parent = "pkg"): Node => ({ id, role: "file", parent, group: parent });
const imp = (from: string, to: string, type = false): Edge => ({
  from,
  to,
  kind: "imports",
  ...(type ? { attrs: { type: true } } : {}),
});
const graph = (layer: string, nodes: Node[], edges: Edge[] = []): Graph => ({
  layer,
  nodes,
  edges,
});

describe("cycles", () => {
  it("finds runtime loops and skips type-only edges", () => {
    const g = graph(
      "imports",
      ["a", "b", "c", "d", "e"].map((x) => file(x)),
      [imp("a", "b"), imp("b", "c"), imp("c", "a"), imp("d", "e"), imp("e", "d", true)],
    );
    expect(cycles(g)).toEqual([["a", "b", "c"]]);
  });

  it("puts the largest loop first", () => {
    const g = graph(
      "imports",
      [],
      [imp("x", "y"), imp("y", "x"), imp("a", "b"), imp("b", "c"), imp("c", "a")],
    );
    expect(cycles(g).map((c) => c.length)).toEqual([3, 2]);
  });
});

describe("fromGraphs", () => {
  it("counts flat folders, fan-in, fan-out and inferred exports", () => {
    const many = Array.from({ length: FLAT_OVER + 1 }, (_, i) => file(`pkg/src/f${i}.ts`));
    const edges = many.slice(1).map((f) => imp(f.id, "pkg/src/f0.ts"));
    const api = graph("api", [
      { id: "pkg#a", role: "export", group: "pkg", attrs: { inferred: true } },
      { id: "pkg#b", role: "export", group: "pkg" },
      { id: "lib#c", role: "export", group: "lib" },
    ]);
    const h = fromGraphs(graph("imports", many, edges), api);
    expect(h.flat).toEqual([{ folder: "pkg", boxes: FLAT_OVER + 1 }]);
    expect(h.fanIn[0]).toEqual({ file: "pkg/src/f0.ts", n: FLAT_OVER });
    expect(h.fanOut).toHaveLength(15);
    expect(h.inferred).toEqual([{ pkg: "pkg", n: 1, of: 2 }]);
    expect(h.cycles).toEqual([]);
  });

  it("works with no graphs", () => {
    expect(fromGraphs(null, null)).toEqual({
      cycles: [],
      flat: [],
      fanIn: [],
      fanOut: [],
      inferred: [],
    });
  });
});

describe("tool reports", () => {
  it("reads jscpd with repo paths, largest clone first", () => {
    const at = (name: string, a: number, b: number) => ({
      name,
      startLoc: { line: a },
      endLoc: { line: b },
    });
    const d = fromJscpd(
      {
        statistics: { total: { percentage: 1.234, clones: 2, duplicatedLines: 30 } },
        duplicates: [
          { lines: 10, firstFile: at("/r/a.ts", 1, 10), secondFile: at("/r/b.ts", 5, 14) },
          { lines: 20, firstFile: at("/r/c.ts", 1, 20), secondFile: at("/r/d/e.ts", 1, 20) },
        ],
      },
      "/r",
    );
    expect(d).toMatchObject({ percent: 1.23, clones: 2, lines: 30 });
    expect(d.top[0]).toEqual({ lines: 20, a: "c.ts:1-20", b: "d/e.ts:1-20" });
  });

  it("reads knip exports, types and dependencies", () => {
    const u = fromKnip({
      issues: [
        { file: "packages/a/src/x.ts", exports: [{ name: "x" }], types: [], dependencies: [] },
        {
          file: "packages/a/package.json",
          exports: [],
          types: [],
          dependencies: [{ name: "lodash" }],
        },
      ],
    });
    expect(u.exports).toEqual([{ file: "packages/a/src/x.ts", name: "x" }]);
    expect(u.dependencies).toEqual([{ file: "packages/a/package.json", name: "lodash" }]);
    expect(u.types).toEqual([]);
  });
});

describe("page", () => {
  it("lists cycles as sets and leaves out the tool sections without tools", () => {
    const md = page({ cycles: [["a", "b"]], flat: [], fanIn: [], fanOut: [], inferred: [] });
    expect(md).toContain("- `a`, `b`");
    expect(md).not.toContain("Duplicated lines");
    expect(md).not.toContain("Unused");
  });
});
