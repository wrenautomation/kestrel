import { describe, expect, it } from "vitest";
import type { Graph } from "./graph.js";
import { parseLog, recentOf, recentPage } from "./recent.js";

const imports: Graph = {
  layer: "imports",
  nodes: [
    { id: "@s/a", role: "package", group: "@s/a", attrs: { dir: "packages/a/" } },
    { id: "@s/ab", role: "package", group: "@s/ab", attrs: { dir: "packages/ab/" } },
  ],
  edges: [],
};

const log = [
  "\0c1",
  "",
  "3\t1\tpackages/a/src/x.ts",
  "2\t0\tpackages/ab/src/y.ts",
  "\0c2",
  "",
  "1\t1\tpackages/a/src/x.ts",
  "-\t-\tpackages/a/logo.png",
  "4\t0\tpackages/a/src/{old => new}/z.ts",
  "\0c3",
  "",
  "5\t5\tdocs/notes.md",
  "1\t0\tpackage.json",
].join("\n");

describe("recent", () => {
  it("parses numstat, a binary as 0 lines, a rename as its new path", () => {
    const c = parseLog(log);
    expect(c.map((x) => x.sha)).toEqual(["c1", "c2", "c3"]);
    expect(c[1]?.files).toEqual([
      { path: "packages/a/src/x.ts", added: 1, removed: 1 },
      { path: "packages/a/logo.png", added: 0, removed: 0 },
      { path: "packages/a/src/new/z.ts", added: 4, removed: 0 },
    ]);
  });

  it("rolls commits up to the longest package dir, the rest to their top folder", () => {
    const r = recentOf(parseLog(log), imports, 14);
    expect(r.commits).toBe(3);
    expect(r.packages).toEqual([
      { id: "@s/a", commits: 2, files: 3, added: 8, removed: 2 },
      { id: "docs/", commits: 1, files: 1, added: 5, removed: 5 },
      { id: "@s/ab", commits: 1, files: 1, added: 2, removed: 0 },
      { id: "package.json", commits: 1, files: 1, added: 1, removed: 0 },
    ]);
    expect(r.files[0]).toEqual({ path: "packages/a/src/x.ts", commits: 2, added: 4, removed: 2 });
    expect(recentPage(r)).toContain("| `@s/a` | 2 | 3 | +8 −2 |");
  });
});
