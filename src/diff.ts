/** Approved vs current: what was added, removed or changed, with the group each sits in. */
import { type Attrs, type Edge, edgeId, type Graph, type Node } from "./graph.js";

export type Change =
  | { op: "add" | "remove"; what: "node" | "edge"; group: string; id: string; attrs?: Attrs }
  | { op: "change"; what: "node" | "edge"; group: string; id: string; before: Attrs; after: Attrs };

/** Everything but the id, as one comparable record: role, parent and attrs all count. */
const facts = (x: Node | Edge): Attrs => {
  const { attrs, ...rest } = x as Node & Edge;
  const out: Record<string, Attrs[string]> = {};
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) out[k] = v as string;
  for (const [k, v] of Object.entries(attrs ?? {})) out[`attrs.${k}`] = v;
  return out;
};

const same = (a: Attrs, b: Attrs) => JSON.stringify(a) === JSON.stringify(b);

/** Edge ids are `from -kind-> to`. Empty when the two graphs are the same. */
export function diff(approved: Graph, current: Graph): Change[] {
  const groupOf = new Map<string, string>();
  for (const n of [...approved.nodes, ...current.nodes]) groupOf.set(n.id, n.group);
  const out: Change[] = [];
  const side = <T extends Node | Edge>(
    what: "node" | "edge",
    a: readonly T[],
    b: readonly T[],
    id: (x: T) => string,
    group: (x: T) => string,
  ) => {
    const before = new Map(a.map((x) => [id(x), x]));
    const after = new Map(b.map((x) => [id(x), x]));
    for (const [k, x] of before)
      if (!after.has(k)) out.push({ op: "remove", what, group: group(x), id: k, attrs: facts(x) });
    for (const [k, x] of after) {
      const old = before.get(k);
      if (!old) out.push({ op: "add", what, group: group(x), id: k, attrs: facts(x) });
      else if (!same(facts(old), facts(x)))
        out.push({
          op: "change",
          what,
          group: group(x),
          id: k,
          before: facts(old),
          after: facts(x),
        });
    }
  };
  side(
    "node",
    approved.nodes,
    current.nodes,
    (n) => n.id,
    (n) => n.group,
  );
  side("edge", approved.edges, current.edges, edgeId, (e) => groupOf.get(e.from) ?? "_");
  return out.sort((x, y) => (x.group + x.id < y.group + y.id ? -1 : 1));
}

const SIGN = { add: "+", remove: "-", change: "~" } as const;

/** One line per change, under its group, for the gate's failure output. */
export function formatChanges(changes: readonly Change[]): string {
  const lines: string[] = [];
  let group = "";
  for (const c of changes) {
    if (c.group !== group) {
      group = c.group;
      lines.push(`  ${group}`);
    }
    let line = `    ${SIGN[c.op]} ${c.what} ${c.id}`;
    if (c.op === "change") {
      const keys = new Set([...Object.keys(c.before), ...Object.keys(c.after)]);
      const moved = [...keys].filter(
        (k) => JSON.stringify(c.before[k]) !== JSON.stringify(c.after[k]),
      );
      line += ` (${moved.join(", ")})`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}
