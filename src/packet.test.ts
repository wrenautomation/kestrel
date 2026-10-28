import { describe, expect, it } from "vitest";
import { indexOf, parseCard } from "./cards.js";
import type { Graph } from "./graph.js";
import { packet } from "./packet.js";

const imports = (files: [string, string][], edges: [string, string][]): Graph => ({
  layer: "imports",
  nodes: [
    { id: "@x/a", role: "package", group: "@x/a", attrs: { dir: "packages/a/" } },
    { id: "@x/b", role: "package", group: "@x/b", attrs: { dir: "packages/b/" } },
    ...files.map(([id, parent]) => ({ id, role: "file" as const, parent, group: parent })),
  ],
  edges: edges.map(([from, to]) => ({ from, to, kind: "imports" })),
});

const api = (sig: string): Graph => ({
  layer: "api",
  nodes: [
    {
      id: "@x/a#run",
      role: "export",
      group: "@x/a",
      attrs: { file: "packages/a/src/run.ts", sig },
    },
  ],
  edges: [],
});

describe("packet", () => {
  const files: [string, string][] = [
    ["@x/a/src/run.ts", "@x/a"],
    ["@x/b/src/use.ts", "@x/b"],
  ];
  const was = [imports(files, []), api("run(): void")];
  const now = [
    imports(files, [["@x/b/src/use.ts", "@x/a/src/run.ts"]]),
    api("run(n: number): void"),
  ];
  const card = parseCard(
    "map/objects/run.md",
    "---\ntype: object\ncovers: ['@x/a#run']\n---\n# Run\n\nOne pass.\n",
  );

  it("lifts file imports to package uses and shows what moved in a signature", () => {
    const md = packet({
      layers: [
        { id: "imports", approved: was[0] ?? null, current: now[0] ?? null },
        { id: "api", approved: was[1] ?? null, current: now[1] ?? null },
      ],
      cards: card ? [card] : [],
      was: indexOf(was),
      now: indexOf(now),
      measures: { cost: null, health: null },
    });
    expect(md).toContain("| imports | 1 | 0 | 0 |");
    expect(md).toContain("- `@x/b` uses `@x/a` (1 imports)");
    expect(md).toContain("File imports: 1 added, 0 removed.");
    expect(md).toContain("  - sig: `run(): void` → `run(n: number): void`");
    expect(md).toContain("## Cards to read again");
    expect(md).toContain("- `map/objects/run.md`: One pass.");
  });

  it("says when a layer has nothing approved, and skips a layer not generated", () => {
    const md = packet({
      layers: [
        { id: "api", approved: null, current: now[1] ?? null },
        { id: "schema", approved: null, current: null },
      ],
      cards: [],
      was: indexOf([]),
      now: indexOf(now),
      measures: { cost: null, health: null },
    });
    expect(md).toContain("Nothing approved yet: every node is new.");
    expect(md).toContain("- `@x/a#run`: `run(n: number): void`");
    expect(md).not.toContain("| schema |");
    expect(md).not.toContain("Cards to read again");
  });
});
