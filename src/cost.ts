/**
 * The cost report: what the system cost to run, per map node. The repo prints its spend lines
 * with its own dump command (`cost.dump` in kestrel.json): `{from, to, days, lines: [{source,
 * key, usd, calls?}]}`, where `source` is `aws` or a vendor and `key` an AWS service or the part
 * that spent it. A part's owner comes from the code: the package whose files name the part
 * (`cost.parts`, a pattern). What code cannot tell (an AWS service) comes from `cost.owners`.
 * Spend is not part of the map: nothing approves it, and the page stays out of a public repo.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Graph } from "./graph.js";

export const CostDump = z.object({
  from: z.string(),
  to: z.string(),
  days: z.number().positive(),
  lines: z.array(
    z.object({
      source: z.string(),
      key: z.string(),
      usd: z.number(),
      calls: z.number().optional(),
    }),
  ),
});
export type CostDump = z.infer<typeof CostDump>;

export interface CostLine {
  source: string;
  key: string;
  usd: number;
  calls?: number | undefined;
  /** The map node it is spent by; none when no owner is known. */
  owner?: string;
}

export interface Cost {
  from: string;
  to: string;
  days: number;
  lines: CostLine[];
}

const TEST = /(^|\/)(test|tests|__tests__)\/|\.(test|spec|stories)\.tsx?$/;

/**
 * Each part name the code holds, and its package: `pattern`'s group 1 in each file of the imports
 * graph, tests left out. A part named in two packages goes to the one that names it most.
 */
export async function partOwners(
  root: string,
  imports: Graph,
  pattern: string,
): Promise<Map<string, string>> {
  const dir = new Map<string, string>();
  for (const n of imports.nodes)
    if (n.role === "package" && typeof n.attrs?.dir === "string") dir.set(n.id, n.attrs.dir);
  const hits = new Map<string, Map<string, number>>();
  const re = new RegExp(pattern, "g");
  for (const n of imports.nodes) {
    const base = n.parent ? dir.get(n.parent) : undefined;
    if (n.role !== "file" || !n.parent || base === undefined) continue;
    const path = join(base, n.id.slice(n.parent.length + 1));
    if (TEST.test(path)) continue;
    const text = await readFile(join(root, path), "utf8").catch(() => "");
    for (const m of text.matchAll(re)) {
      const part = m[1];
      if (!part) continue;
      const by = hits.get(part) ?? new Map<string, number>();
      by.set(n.parent, (by.get(n.parent) ?? 0) + 1);
      hits.set(part, by);
    }
  }
  const out = new Map<string, string>();
  for (const [part, by] of hits) {
    const [pkg] = [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
    if (pkg) out.set(part, pkg);
  }
  return out;
}

/**
 * Each line's owner: `owners["source:key"]`, else the part's package. A dotted part with no owner
 * of its own takes its prefix's (`learn.score` → `learn`).
 */
export function attribute(
  d: CostDump,
  owners: Record<string, string>,
  parts: Map<string, string>,
): Cost {
  const ofPart = (key: string): string | undefined => {
    for (let k = key; k; k = k.includes(".") ? k.slice(0, k.lastIndexOf(".")) : "") {
      const o = parts.get(k);
      if (o) return o;
    }
    return undefined;
  };
  return {
    from: d.from,
    to: d.to,
    days: d.days,
    lines: d.lines.map((l) => {
      const owner = owners[`${l.source}:${l.key}`] ?? ofPart(l.key);
      return { ...l, ...(owner ? { owner } : {}) };
    }),
  };
}

/** USD per node, over the report's days. */
export function byOwner(c: Cost): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of c.lines) if (l.owner) m.set(l.owner, (m.get(l.owner) ?? 0) + l.usd);
  return m;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export function page(c: Cost): string {
  const tick = (s: string) => `\`${s}\``;
  const total = c.lines.reduce((n, l) => n + l.usd, 0);
  const L = [
    "# Cost",
    "",
    `What it cost to run from ${c.from} to ${c.to} (${c.days} days): ${usd(total)}. Local only: never commit this page.`,
    "",
    "| Owner | USD | Lines |",
    "|---|---|---|",
  ];
  const owned = [...byOwner(c)].sort((a, b) => b[1] - a[1]);
  for (const [owner, n] of owned) {
    const lines = c.lines.filter((l) => l.owner === owner);
    L.push(
      `| ${tick(owner)} | ${usd(n)} | ${lines.map((l) => `${l.source} ${l.key} ${usd(l.usd)}`).join("; ")} |`,
    );
  }
  const none = c.lines.filter((l) => !l.owner);
  if (none.length) {
    L.push("", "## No owner", "", "Add each to `cost.owners` in kestrel.json.", "");
    L.push("| Source | Key | USD |", "|---|---|---|");
    for (const l of none) L.push(`| ${l.source} | ${tick(l.key || "(none)")} | ${usd(l.usd)} |`);
  }
  return `${L.join("\n")}\n`;
}

/**
 * A decision card's trigger: the measure that, once over `over`, says the choice is due again.
 * Closed, like roles: `cost` is a node's USD per 30 days; the rest come from the health report.
 */
export const Trigger = z.object({
  metric: z.enum(["cost", "cycles", "duplicates", "unused", "inferred"]),
  /** `cost` only: the node that spends. */
  node: z.string().optional(),
  over: z.number(),
});
export type Trigger = z.infer<typeof Trigger>;

export interface Measures {
  cost: Cost | null;
  health: {
    cycles: unknown[];
    inferred: { n: number }[];
    duplicates?: { percent: number };
    unused?: { exports: unknown[] };
  } | null;
}

/** The trigger's measure now, or null when nothing measured it (no report on disk). */
export function measure(t: Trigger, m: Measures): number | null {
  if (t.metric === "cost") {
    if (!m.cost || !t.node) return null;
    return ((byOwner(m.cost).get(t.node) ?? 0) * 30) / m.cost.days;
  }
  const h = m.health;
  if (!h) return null;
  if (t.metric === "cycles") return h.cycles.length;
  if (t.metric === "inferred") return h.inferred.reduce((n, p) => n + p.n, 0);
  if (t.metric === "duplicates") return h.duplicates?.percent ?? null;
  return h.unused?.exports.length ?? null;
}
