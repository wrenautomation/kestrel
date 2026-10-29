import { describe, expect, it } from "vitest";
import { implied } from "./reduce.js";

const E = (s: string) => s.split(" ").map((p) => ({ from: p[0] as string, to: p[1] as string }));

describe("implied", () => {
  it("drops a line that a longer path covers", () => {
    expect([...implied(E("ab bc ac"))]).toEqual([2]);
  });

  it("keeps parallel lines and lone ones", () => {
    expect(implied(E("ab ab cd")).size).toBe(0);
  });

  it("keeps a cycle's own lines, drops a shortcut past it", () => {
    // u, w, v: u↔w is one part, so u→v and w→v are one part pair, never implied by each other.
    expect(implied(E("uw wu uv wv")).size).toBe(0);
    // a → (b↔c) → d, plus a→d.
    expect([...implied(E("ab bc cb cd ad"))]).toEqual([4]);
  });
});
