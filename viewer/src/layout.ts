/**
 * The shown map under a root: orrery folds it and nests the layouts; ELK (its own worker) or a grid
 * places each open container's kids. Box sizes come from the real text (size.ts).
 */
import {
  type Engine,
  type Fold,
  type FoldNode,
  type Laid,
  type NestCache,
  type Nested,
  nest,
  openSet,
} from "@wrenautomation/orrery";
import ElkConstructor, { type ELK, type ElkNode } from "elkjs/lib/elk-api.js";
import workerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { Level, TreeNode, ViewData } from "../../src/view/types";
import { boxSize, ZONE } from "./size";

/** Each level's line routes, in `Level.edges` order, relative to the level. Empty on a grid. */
export type Routes = [number, number][][];
export type Shown = Nested<Routes>;

/** Over this many boxes the depth cut leaves a container shut: it opens by hand only. */
const HAND_OVER = 40;

/** The tree under `root`, its kids at depth 0, as orrery reads it. */
export function foldNodes(data: ViewData, root: string): FoldNode[] {
  const out: FoldNode[] = [];
  const walk = (id: string) => {
    for (const k of data.nodes[id]?.kids ?? []) {
      const n = data.nodes[k] as TreeNode;
      const big = (data.levels[k]?.boxes.length ?? 0) > HAND_OVER;
      // `root` is no node: orrery reads its kids as depth 0, and nest finds them by it.
      out.push({ id: k, label: n.label, parent: id, hand: big });
      walk(k);
    }
  };
  walk(root);
  return out;
}

const OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.spacing.nodeNodeBetweenLayers": "56",
  "elk.spacing.nodeNode": "28",
  "elk.spacing.componentComponent": "40",
  "elk.aspectRatio": "1.8",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  // Lines into one box share its port: a hub reads as one trunk, not a comb.
  "elk.layered.mergeEdges": "true",
};
// elk-api runs ELK in its own web worker: the page never blocks on a layout.
let elkApi: ELK | undefined;

async function elk(
  kids: readonly { id: string; w: number; h: number }[],
  edges: readonly { from: string; to: string }[],
): Promise<Laid<Routes>> {
  elkApi ??= new ElkConstructor({ workerUrl });
  const graph: ElkNode = {
    id: "root",
    layoutOptions: OPTIONS,
    children: kids.map((k) => ({ id: k.id, width: k.w, height: k.h })),
    edges: edges.map((x, i) => ({ id: `e${i}`, sources: [x.from], targets: [x.to] })),
  };
  const out = await elkApi.layout(graph);
  const at: Record<string, [number, number]> = {};
  for (const c of out.children ?? []) at[c.id] = [Math.round(c.x ?? 0), Math.round(c.y ?? 0)];
  const byId = new Map((out.edges ?? []).map((x) => [x.id, x]));
  const routes = edges.map((_, i) => {
    const q = byId.get(`e${i}`)?.sections?.[0];
    return q
      ? [q.startPoint, ...(q.bendPoints ?? []), q.endPoint].map((v): [number, number] => [
          Math.round(v.x),
          Math.round(v.y),
        ])
      : [];
  });
  return { w: Math.round(out.width ?? 0), h: Math.round(out.height ?? 0), at, extra: routes };
}

/** Rows of up to 8, in the level's order; each cell as wide as the widest box. */
function grid(kids: readonly { id: string; w: number; h: number }[]): Laid<Routes> {
  const cols = Math.max(1, Math.min(8, Math.ceil(Math.sqrt(kids.length * 1.8))));
  const cw = Math.max(...kids.map((k) => k.w)) + 24;
  const at: Record<string, [number, number]> = {};
  let y = 0;
  for (let r = 0; r * cols < kids.length; r++) {
    const row = kids.slice(r * cols, (r + 1) * cols);
    row.forEach((k, i) => {
      at[k.id] = [i * cw, y];
    });
    y += Math.max(...row.map((k) => k.h)) + 24;
  }
  return { w: Math.min(kids.length, cols) * cw - 24, h: y - 24, at, extra: [] };
}

const engineOf =
  (data: ViewData): Engine<Routes> =>
  async (id, kids) => {
    const lvl = data.levels[id] as Level;
    if (lvl.grid || !lvl.edges.length) {
      // A grid keeps the level's order: by fan-in.
      const rank = new Map(lvl.boxes.map((b, i) => [b.id, i]));
      return grid([...kids].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)));
    }
    // Implied lines get no route: the layout packs by the skeleton only.
    const keep = lvl.edges.flatMap((e, i) => (e.implied ? [] : [i]));
    const laid = await elk(
      kids,
      keep.map((i) => lvl.edges[i] as Level["edges"][number]),
    );
    const routes: Routes = lvl.edges.map(() => []);
    keep.forEach((i, j) => {
      routes[i] = laid.extra?.[j] ?? [];
    });
    return { ...laid, extra: routes };
  };

const caches = new WeakMap<ViewData, NestCache<Routes>>();

export function shown(
  data: ViewData,
  root: string,
  fold: Fold,
  top: (n: TreeNode) => number,
): Promise<Shown> {
  const nodes = foldNodes(data, root);
  const fanIn = new Map<string, number>();
  for (const l of Object.values(data.levels)) for (const b of l.boxes) fanIn.set(b.id, b.fanIn);
  const cache = caches.get(data) ?? new Map();
  caches.set(data, cache);
  return nest({
    nodes,
    root,
    open: openSet(nodes, fold),
    size: (id) => {
      const n = data.nodes[id] as TreeNode;
      return boxSize(n, fanIn.get(id) ?? 0, top(n));
    },
    pad: ZONE,
    engine: engineOf(data),
    cache,
  });
}
