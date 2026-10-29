/**
 * A screen's slice: the routes it calls, the tables behind them, what they reach outside. Calls
 * are the ui layer's `calls` edges; tables, the routes' `reads`/`writes` edges and a record
 * screen's own `reads`; outside, the systems layer's route `uses` edges and route attrs `npm` and
 * `hosts`. Shared: a call or table more than a quarter of the calling screens reach (the access
 * checks' tables, the session route), the same cut as the ui shell and the routes stack.
 */
import type { Graph } from "../graph.js";
import type { Slice, SliceItem } from "./types.js";

export const SHARED = 0.25;

const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);

export function slices(
  layers: { ui: Graph | null; routes: Graph | null; systems: Graph | null },
  /** Box id of a route's file, or of a table or system box the map has. */
  boxOf: (id: string) => string | undefined,
): Map<string, Slice> {
  const { ui, routes, systems } = layers;
  const out = new Map<string, Slice>();
  if (!ui) return out;
  const route = new Map((routes?.nodes ?? []).map((n) => [n.id, n]));
  const touch = new Map<string, { to: string; write: boolean }[]>();
  for (const e of routes?.edges ?? [])
    if (e.kind === "reads" || e.kind === "writes")
      touch.set(e.from, [...(touch.get(e.from) ?? []), { to: e.to, write: e.kind === "writes" }]);
  const uses = new Map<string, string[]>();
  for (const e of systems?.edges ?? [])
    if (e.kind === "uses" && e.from.startsWith("route:"))
      uses.set(e.from, [...(uses.get(e.from) ?? []), e.to]);
  const sysPkgs = new Map<string, Set<string>>();
  for (const e of systems?.edges ?? [])
    if (e.kind === "uses" && e.from.startsWith("route:"))
      for (const t of list(e.attrs?.title))
        sysPkgs.set(e.from, (sysPkgs.get(e.from) ?? new Set()).add(t.replace(/^npm `|`$/g, "")));

  const calls = new Map<string, { to: string; at: string[] }[]>();
  const own = new Map<string, string[]>();
  for (const e of ui.edges) {
    if (e.kind === "calls")
      calls.set(e.from, [...(calls.get(e.from) ?? []), { to: e.to, at: list(e.attrs?.at) }]);
    if (e.kind === "reads") own.set(e.from, [...(own.get(e.from) ?? []), e.to]);
  }

  for (const s of ui.nodes) {
    if (s.role !== "screen") continue;
    const c = calls.get(s.id) ?? [];
    const mine = own.get(s.id) ?? [];
    const missing = list(s.attrs?.missing);
    const host = list(s.attrs?.host);
    if (!c.length && !mine.length && !missing.length && !host.length) continue;
    const tables = new Map<string, SliceItem>();
    const outside = new Map<string, SliceItem>();
    const put = (m: Map<string, SliceItem>, it: Omit<SliceItem, "via">, via: string) => {
      const k = `${it.kind}\0${it.id}`;
      const had = m.get(k);
      if (had) had.via.includes(via) || had.via.push(via);
      else {
        const box = boxOf(it.id);
        m.set(k, { ...it, ...(box ? { box } : {}), via: [via] });
      }
    };
    for (const t of mine) put(tables, { id: t, label: t.slice(6), kind: "reads" }, s.id);
    for (const { to } of c) {
      for (const t of touch.get(to) ?? [])
        put(tables, { id: t.to, label: t.to.slice(6), kind: t.write ? "writes" : "reads" }, to);
      for (const sys of uses.get(to) ?? [])
        put(outside, { id: sys, label: sys.slice(7), kind: "system" }, to);
      const r = route.get(to);
      for (const p of list(r?.attrs?.npm))
        if (!sysPkgs.get(to)?.has(p)) put(outside, { id: `npm:${p}`, label: p, kind: "npm" }, to);
      for (const h of list(r?.attrs?.hosts))
        put(outside, { id: `host:${h}`, label: h, kind: "host" }, to);
    }
    // a table both read and written shows once, as written
    for (const [k, it] of tables)
      if (it.kind === "reads" && tables.has(`writes\0${it.id}`)) {
        const w = tables.get(`writes\0${it.id}`) as SliceItem;
        for (const v of it.via) w.via.includes(v) || w.via.push(v);
        tables.delete(k);
      }
    out.set(s.id, {
      calls: c.map(({ to, at }) => {
        const box = boxOf(to);
        return {
          id: to,
          name: to.slice("route:".length),
          ...(box ? { box } : {}),
          at,
        };
      }),
      tables: [...tables.values()],
      outside: [...outside.values()],
      ...(missing.length ? { missing } : {}),
      ...(host.length ? { host } : {}),
    });
  }

  // shared: over a quarter of the screens that call reach it through a call; a record's own
  // view is not counted
  const seen = new Map<string, number>();
  const count = (k: string) => seen.set(k, (seen.get(k) ?? 0) + 1);
  let calling = 0;
  for (const [id, sl] of out) {
    if (!sl.calls.length) continue;
    calling++;
    for (const c of sl.calls) count(c.id);
    for (const t of sl.tables) if (t.via.some((v) => v !== id)) count(t.id);
  }
  const over = calling * SHARED;
  for (const sl of out.values()) {
    for (const c of sl.calls) if ((seen.get(c.id) ?? 0) > over) c.shared = true;
    for (const t of sl.tables) if ((seen.get(t.id) ?? 0) > over) t.shared = true;
    const by = (a: { id: string; shared?: true }, b: { id: string; shared?: true }) =>
      Number(!!a.shared) - Number(!!b.shared) || a.id.localeCompare(b.id);
    sl.calls.sort(by);
    sl.tables.sort(by);
    sl.outside.sort(by);
  }
  return out;
}
