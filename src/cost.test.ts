import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCards, indexOf, parseCard } from "./cards.js";
import { attribute, byOwner, type Cost, measure, page, partOwners } from "./cost.js";
import type { Graph } from "./graph.js";

const dump = {
  from: "2026-10-01",
  to: "2026-10-16",
  days: 15,
  lines: [
    { source: "aws", key: "AWS Lambda", usd: 2 },
    { source: "anthropic", key: "learn.score", usd: 1.5, calls: 9 },
    { source: "anthropic", key: "drafts", usd: 0.5 },
    { source: "aws", key: "Tax", usd: 0.1 },
  ],
};

describe("attribute", () => {
  it("takes owners first, then the part, then the part's prefix", () => {
    const c = attribute(
      dump,
      { "aws:AWS Lambda": "system:wren.worker" },
      new Map([
        ["learn", "@wren/learn"],
        ["drafts", "@wren/worker"],
      ]),
    );
    expect(c.lines.map((l) => l.owner)).toEqual([
      "system:wren.worker",
      "@wren/learn",
      "@wren/worker",
      undefined,
    ]);
    expect(byOwner(c).get("@wren/learn")).toBe(1.5);
    const md = page(c);
    expect(md).toContain("$4.10");
    expect(md).toContain("## No owner");
    expect(md).toContain("`Tax`");
  });
});

describe("partOwners", () => {
  it("gives a part to the package that names it most, tests left out", async () => {
    const root = await mkdtemp(join(tmpdir(), "kestrel-cost-"));
    await mkdir(join(root, "packages/a/src"), { recursive: true });
    await mkdir(join(root, "packages/b/src"), { recursive: true });
    await writeFile(
      join(root, "packages/a/src/x.ts"),
      'f({ part: "drafts" }); g({ part: "drafts" });',
    );
    await writeFile(
      join(root, "packages/b/src/y.ts"),
      'f({ part: "drafts" }); withPart(llm, "learn");',
    );
    await writeFile(
      join(root, "packages/b/src/y.test.ts"),
      'f({ part: "drafts" }); f({ part: "drafts" });',
    );
    const g: Graph = {
      layer: "imports",
      nodes: [
        { id: "@x/a", role: "package", group: "@x/a", attrs: { dir: "packages/a/" } },
        { id: "@x/b", role: "package", group: "@x/b", attrs: { dir: "packages/b/" } },
        { id: "@x/a/src/x.ts", role: "file", parent: "@x/a", group: "@x/a" },
        { id: "@x/b/src/y.ts", role: "file", parent: "@x/b", group: "@x/b" },
        { id: "@x/b/src/y.test.ts", role: "file", parent: "@x/b", group: "@x/b" },
      ],
      edges: [],
    };
    const parts = await partOwners(root, g, '(?:withPart\\([^,]+,\\s*|\\bpart:\\s*)"([a-z.]+)"');
    expect(Object.fromEntries(parts)).toEqual({ drafts: "@x/a", learn: "@x/b" });
  });
});

describe("triggers", () => {
  const cost: Cost = attribute(dump, { "aws:AWS Lambda": "system:wren.worker" }, new Map());
  const health = { cycles: [["a", "b"]], inferred: [{ n: 3 }], duplicates: { percent: 1.2 } };

  it("measures cost per 30 days and the health signals", () => {
    const m = { cost, health };
    expect(measure({ metric: "cost", node: "system:wren.worker", over: 1 }, m)).toBe(4);
    expect(measure({ metric: "cycles", over: 1 }, m)).toBe(1);
    expect(measure({ metric: "duplicates", over: 1 }, m)).toBe(1.2);
    expect(measure({ metric: "unused", over: 1 }, m)).toBeNull();
    expect(measure({ metric: "cost", node: "x", over: 1 }, { cost: null, health })).toBeNull();
  });

  it("flags a crossed trigger, a bad one, and one with no data", async () => {
    const card = (name: string, trigger: string) =>
      parseCard(
        `map/decisions/${name}.md`,
        `---\ntype: decision\ntrigger: ${trigger}\n---\n# ${name}\n`,
      );
    const cards = [
      card("lambda", "{metric: cost, node: system:wren.worker, over: 3}"),
      card("cheap", "{metric: cost, node: system:wren.worker, over: 10}"),
      card("bad", "{metric: speed, over: 1}"),
      card("loops", "{metric: cycles, over: 0}"),
    ].filter((c) => c !== null);
    const issues = await checkCards("/", cards, indexOf([]), [], { cost, health: null });
    expect(issues.map((i) => `${i.rule} ${"card" in i ? i.card : ""}`)).toEqual([
      "switch map/decisions/lambda.md",
      "trigger map/decisions/bad.md",
      "unmeasured map/decisions/loops.md",
    ]);
  });
});
