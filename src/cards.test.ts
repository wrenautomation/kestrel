import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCards, coveredBy, indexOf, parseCard, readCards, restamp, stampOf } from "./cards.js";
import type { Graph } from "./graph.js";

const imports: Graph = {
  layer: "imports",
  nodes: [
    { id: "@s/a", role: "package", group: "@s/a", attrs: { dir: "packages/a/" } },
    { id: "@s/b", role: "package", group: "@s/b", attrs: { dir: "packages/b/" } },
    { id: "@s/a/src/x.ts", role: "file", parent: "@s/a", group: "@s/a" },
  ],
  edges: [],
};
const api = (sig: string): Graph => ({
  layer: "api",
  nodes: [
    {
      id: "@s/a#run",
      role: "export",
      group: "@s/a",
      attrs: { file: "packages/a/src/x.ts", kind: "function", sig },
    },
  ],
  edges: [],
});

const card = (front: string, body = "# t\n\nFirst.\n\n## Why this shape\n\nBecause.\n") =>
  `---\n${front}\n---\n\n${body}`;

describe("cards", () => {
  it("reads frontmatter and the why, and skips Markdown with no frontmatter", () => {
    const c = parseCard("map/c.md", card("type: object\nentity: packages/a/src/x.ts:12"));
    expect(c).toMatchObject({ type: "object", entity: "packages/a/src/x.ts:12", why: "Because." });
    expect(parseCard("map/c.md", card("type: pattern", "# t\n\nOnly this.\n"))?.why).toBe(
      "Only this.",
    );
    expect(parseCard("map/README.md", "# no front\n")).toBeNull();
    const loose = parseCard("m.md", card('verified: 2026-10-20 (O2: a: b)\ncovers: [x, "y"]'));
    expect(loose?.covers).toEqual(["x", "y"]);
  });

  it("covers the entity's file and its exports", () => {
    const c = parseCard("m.md", card("entity: packages/a/src/x.ts:1"));
    expect(c && coveredBy(c, indexOf([imports, api("() => void")]))).toEqual([
      "@s/a#run",
      "@s/a/src/x.ts",
    ]);
  });

  it("is stale only once stamped and a covered signature changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "kestrel-cards-"));
    await mkdir(join(root, "map/o"), { recursive: true });
    await mkdir(join(root, "packages/a/src"), { recursive: true });
    await writeFile(join(root, "packages/a/src/x.ts"), "");
    const file = join(root, "map/o/x.md");
    await writeFile(file, card("type: object\nentity: packages/a/src/x.ts:1"));
    const before = indexOf([imports, api("() => void")]);
    const after = indexOf([imports, api("(n: number) => void")]);
    const read = async () =>
      (await readCards(root, "map"))[0] as NonNullable<ReturnType<typeof parseCard>>;

    expect(await checkCards(root, [await read()], after, ["package"])).toEqual([
      { rule: "coverage", node: "@s/b" },
    ]);
    await restamp(root, await read(), before);
    const text = await readFile(file, "utf8");
    expect(text).toContain(
      `entity: packages/a/src/x.ts:1\nstamp: ${stampOf(await read(), before)}\n---`,
    );
    expect(await checkCards(root, [await read()], before, [])).toEqual([]);
    expect(await checkCards(root, [await read()], after, [])).toEqual([
      { rule: "stale", card: "map/o/x.md" },
    ]);
    await restamp(root, await read(), after);
    expect((await readFile(file, "utf8")).match(/stamp:/g)).toHaveLength(1);
  });

  it("flags an entity whose file is gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "kestrel-cards-"));
    const c = parseCard("m.md", card("entity: packages/a/src/gone.ts:3"));
    expect(c && (await checkCards(root, [c], indexOf([]), []))).toEqual([
      { rule: "entity", card: "m.md", entity: "packages/a/src/gone.ts" },
    ]);
  });
});
