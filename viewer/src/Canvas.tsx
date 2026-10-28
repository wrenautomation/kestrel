import {
  BaseEdge,
  type Edge,
  type EdgeProps,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  type ReactFlowInstance,
  useStore,
} from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import rough from "roughjs";
import type { Drawable, Options } from "roughjs/bin/core";
import type { LevelBox, TreeNode, ViewData } from "../../src/view/types";

type BoxData = { n: TreeNode; box: LevelBox; selected: boolean; near: boolean; dim: boolean };
type LineData = {
  points: [number, number][];
  n: number;
  type: boolean;
  hot: boolean;
  dim: boolean;
  faint: boolean;
};

/** Past this many lines a level reads as a hairball: draw them faint until a box is picked. */
const FAINT_OVER = 60;
/** Fit never shrinks a level below this; the minimap shows the rest. */
const FIT_MIN = 0.45;

/**
 * Role reads from the outline, as in a system design chart: a drum holds data, a pill is a
 * service, a dashed box holds other boxes. Rough.js (Excalidraw's renderer) draws it, kept low
 * so it reads formal. The seed comes from the id, so a box looks the same on every load.
 */
type Shape = "rect" | "zone" | "pill" | "drum";
const SHAPE: Record<string, Shape> = {
  repo: "zone",
  dir: "zone",
  folder: "zone",
  systems: "zone",
  screens: "zone",
  service: "pill",
  db: "drum",
  schema: "drum",
  table: "drum",
};
/** A LikeC4 kind on a system or part. */
const KIND: Record<string, Shape> = { store: "drum" };
const shapeOf = (n: TreeNode): Shape =>
  SHAPE[n.role] ??
  ((n.role === "part" || n.role === "system") && n.sub ? KIND[n.sub] : undefined) ??
  "rect";
const sketch = rough.generator();
const seedOf = (id: string) => {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % 2147483646 || 1;
};
/** Drum lid depth; the label moves down by it. */
const lid = (h: number) => Math.min(8, h * 0.13);

const Sketch = memo(function Sketch({
  id,
  shape,
  w,
  h,
}: {
  id: string;
  shape: Shape;
  w: number;
  h: number;
}) {
  const paths = useMemo(() => {
    const o: Options = {
      seed: seedOf(id),
      roughness: 0.55,
      bowing: 0.5,
      strokeWidth: 1.3,
      fill: "fill",
      fillStyle: "solid",
      // toPaths drops strokeLineDash; CSS dashes the zone.
      ...(shape === "zone" ? { disableMultiStroke: true } : {}),
    };
    const { fill: _, fillStyle: __, ...line } = o;
    const m = 1.5;
    const W = w - 2 * m;
    const H = h - 2 * m;
    const at = (d: string) => sketch.path(d, o);
    let ds: Drawable[];
    if (shape === "pill") {
      const r = Math.min(H / 2, 18);
      ds = [
        at(
          `M${m + r},${m} H${m + W - r} A${r},${r} 0 0 1 ${m + W},${m + r} V${m + H - r} A${r},${r} 0 0 1 ${m + W - r},${m + H} H${m + r} A${r},${r} 0 0 1 ${m},${m + H - r} V${m + r} A${r},${r} 0 0 1 ${m + r},${m} Z`,
        ),
      ];
    } else if (shape === "drum") {
      const rx = W / 2;
      const ry = lid(H);
      const top = m + ry;
      const bot = m + H - ry;
      ds = [
        at(
          `M${m},${top} V${bot} A${rx},${ry} 0 0 0 ${m + W},${bot} V${top} A${rx},${ry} 0 0 0 ${m},${top} Z`,
        ),
        sketch.path(`M${m},${top} A${rx},${ry} 0 0 0 ${m + W},${top}`, line),
      ];
    } else ds = [sketch.rectangle(m, m, W, H, o)];
    return ds.flatMap((d) => sketch.toPaths(d));
  }, [id, shape, w, h]);
  return (
    <svg className="sk" width={w} height={h} aria-hidden="true">
      {paths.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed strokes of one shape
        <path key={i} d={p.d} className={p.fill && p.fill !== "none" ? "f" : "s"} />
      ))}
    </svg>
  );
});

const Box = memo(function Box({ data }: NodeProps<Node<BoxData>>) {
  const { n, box } = data;
  const shape = shapeOf(n);
  const cls = [
    "box",
    `shape-${shape}`,
    `role-${n.role}`,
    n.drift ? `drift-${n.drift}` : "",
    data.selected ? "sel" : "",
    data.dim ? "dim" : "",
  ].join(" ");
  return (
    <div
      className={cls}
      style={{
        width: box.w,
        height: box.h,
        ...(shape === "drum" ? { paddingTop: 2 * lid(box.h), paddingBottom: 2 } : {}),
      }}
      title={n.id}
    >
      <Sketch id={n.id} shape={shape} w={box.w} h={box.h} />
      <Handle type="target" position={Position.Left} className="h" />
      <span className="label">
        {/* Break after - . / only, never inside a word. */}
        {n.label.split(/(?<=[-./_])/).map((part, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed label
          <span key={i}>
            {part}
            <wbr />
          </span>
        ))}
      </span>
      <span className="sub">
        {n.tables !== undefined
          ? `${n.tables} table${n.tables === 1 ? "" : "s"}`
          : n.sub
            ? n.sub
            : n.kids.length
              ? `${n.files} file${n.files === 1 ? "" : "s"}`
              : n.role}
        {box.fanIn ? ` · ${box.fanIn} in` : ""}
      </span>
      {n.badge && (
        <span className={`badge ${n.badge}`}>{n.badge === "none" ? "no card" : "stale"}</span>
      )}
      <Handle type="source" position={Position.Right} className="h" />
    </div>
  );
});

function Line({ id, data, markerEnd }: EdgeProps<Edge<LineData>>) {
  const p = data?.points ?? [];
  if (p.length < 2) return null;
  const d = p.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");
  const w = 1 + Math.min(3, Math.log2(data?.n ?? 1) * 0.6);
  const cls = [
    "line",
    data?.type ? "type" : "",
    data?.hot ? "hot" : "",
    data?.dim ? "dim" : "",
    data?.faint ? "faint" : "",
  ].join(" ");
  return (
    <BaseEdge
      id={id}
      path={d}
      className={cls}
      {...(markerEnd ? { markerEnd } : {})}
      style={{ strokeWidth: data?.hot ? w + 0.6 : w }}
    />
  );
}

/** Labels grow as the view shrinks, so a wide level still reads at fit. */
function ZoomVar() {
  const z = useStore((s) => s.transform[2]);
  const el = useStore((s) => s.domNode);
  useEffect(() => {
    el?.style.setProperty("--z", String(z));
    el?.classList.toggle("far", z < 0.7);
  }, [z, el]);
  return null;
}

const nodeTypes = { box: Box };
const edgeTypes = { line: Line };

interface Props {
  data: ViewData;
  focus: string;
  sel: string | undefined;
  onSelect(id: string | undefined): void;
  onOpen(id: string): void;
}

export function Canvas({ data, focus, sel, onSelect, onOpen }: Props) {
  const level = data.levels[focus];
  const near = useMemo(() => {
    const s = new Set<string>();
    for (const e of level?.edges ?? []) {
      if (e.from === sel) s.add(e.to);
      if (e.to === sel) s.add(e.from);
    }
    return s;
  }, [level, sel]);

  const nodes = useMemo<Node<BoxData>[]>(
    () =>
      (level?.boxes ?? []).map((b) => ({
        id: b.id,
        type: "box",
        position: { x: b.x, y: b.y },
        width: b.w,
        height: b.h,
        draggable: false,
        data: {
          n: data.nodes[b.id] as TreeNode,
          box: b,
          selected: b.id === sel,
          near: near.has(b.id),
          // A level with no lines has nothing to dim toward.
          dim: !!sel && (level?.edges.length ?? 0) > 0 && b.id !== sel && !near.has(b.id),
        },
      })),
    [level, data, sel, near],
  );
  const edges = useMemo<Edge<LineData>[]>(() => {
    const at = new Map((level?.boxes ?? []).map((b) => [b.id, b]));
    // A grid level has no routed lines: draw the selected box's, straight, centre to centre.
    const straight = (from: string, to: string): [number, number][] => {
      const a = at.get(from);
      const b = at.get(to);
      if (!a || !b) return [];
      return [
        [a.x + a.w / 2, a.y + a.h / 2],
        [b.x + b.w / 2, b.y + b.h / 2],
      ];
    };
    return (level?.edges ?? []).flatMap((e, i) => {
      const hot = !!sel && (e.from === sel || e.to === sel);
      if (level?.grid && !hot) return [];
      return [
        {
          id: `e${i}`,
          source: e.from,
          target: e.to,
          type: "line",
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
          data: {
            points: level?.grid ? straight(e.from, e.to) : e.points,
            n: e.n,
            type: e.type,
            hot,
            dim: !!sel && !hot,
            faint: !sel && (level?.edges.length ?? 0) > FAINT_OVER,
          },
        },
      ];
    });
  }, [level, sel]);

  // Arrows move the selection to the nearest box that way.
  useEffect(() => {
    const key = (ev: KeyboardEvent) => {
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
        ev.key
      ];
      if (!dir || (ev.target as HTMLElement).closest("input, textarea, select")) return;
      ev.preventDefault();
      const boxes = level?.boxes ?? [];
      const cur = boxes.find((b) => b.id === sel);
      if (!cur) {
        const first = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)[0];
        if (first) onSelect(first.id);
        return;
      }
      const [dx, dy] = dir as [number, number];
      const cx = cur.x + cur.w / 2;
      const cy = cur.y + cur.h / 2;
      let best: { id: string; score: number } | undefined;
      for (const b of boxes) {
        if (b.id === cur.id) continue;
        const ox = b.x + b.w / 2 - cx;
        const oy = b.y + b.h / 2 - cy;
        const along = ox * dx + oy * dy;
        if (along <= 1) continue;
        const score = along + 2 * Math.abs(ox * dy + oy * dx);
        if (!best || score < best.score) best = { id: b.id, score };
      }
      if (best) onSelect(best.id);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [level, sel, onSelect]);

  // A grid opens at its top, full width: the most used files first, like a list.
  const wrap = useRef<HTMLDivElement>(null);
  const onInit = useCallback(
    (rf: ReactFlowInstance<Node<BoxData>, Edge<LineData>>) => {
      if (!level?.grid) return;
      const w = wrap.current?.clientWidth ?? 1000;
      const zoom = Math.min(1.1, Math.max(FIT_MIN, (w - 32) / level.w));
      rf.setViewport({ x: 16, y: 104, zoom });
    },
    [level],
  );

  if (!level) return <div className="canvas msg">Nothing inside {focus}.</div>;
  return (
    <div className="canvas" ref={wrap}>
      {level.grid && (
        <p className="hint">
          {level.edges.length
            ? `${level.boxes.length} boxes in one folder: too flat for a graph. Sorted by fan-in; select a box to see its lines.`
            : `${level.boxes.length} boxes, no lines between them, in their own order.`}
        </p>
      )}
      <ReactFlow
        key={focus}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView={!level.grid}
        fitViewOptions={{ padding: 0.12, maxZoom: 1.1, minZoom: FIT_MIN }}
        onInit={onInit}
        minZoom={0.05}
        maxZoom={2.5}
        nodesConnectable={false}
        nodesDraggable={false}
        elementsSelectable={false}
        onlyRenderVisibleElements
        onNodeClick={(_, n) => onSelect(n.id === sel ? undefined : n.id)}
        onNodeDoubleClick={(_, n) => onOpen(n.id)}
        onPaneClick={() => onSelect(undefined)}
      >
        <ZoomVar />
        {level.boxes.length > 12 && (
          <MiniMap
            pannable
            zoomable
            nodeClassName={(n) => `mm role-${(n.data as BoxData).n.role}`}
          />
        )}
      </ReactFlow>
    </div>
  );
}
