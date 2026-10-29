import { type Fold, type Marks, play, snapshot } from "@wrenautomation/orrery";
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
import { type CSSProperties, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import rough from "roughjs";
import type { Drawable, Options } from "roughjs/bin/core";
import type { TreeNode, ViewData } from "../../src/view/types";
import { type Shown, shown } from "./layout";
import { labelFit, STACK, ZONE } from "./size";

type BoxData = {
  n: TreeNode;
  w: number;
  h: number;
  open: boolean;
  /** Has kids: a tab opens it in place. */
  folds: boolean;
  fanIn: number;
  selected: boolean;
  dim: boolean;
  onToggle(id: string, on: boolean): void;
};
type LineData = {
  points: [number, number][];
  n: number;
  type: boolean;
  hot: boolean;
  dim: boolean;
  faint: boolean;
};

/** Past this many lines a level reads as a hairball: draw them faint until a box is picked. */
const FAINT_OVER = 24;
/** Fit never shrinks the map below this; the minimap shows the rest. */
const FIT_MIN = 0.45;

/**
 * Role reads from the outline, as in a system design chart: a drum holds data, a pill is a
 * service, a dashed box holds other boxes. Rough.js (Excalidraw's renderer) draws it, kept low
 * so it reads formal. The seed comes from the id, so a box looks the same on every load.
 */
type Shape = "rect" | "stack" | "zone" | "pill" | "drum";
// A closed container is a stack of sheets; open, it is a dashed zone.
const SHAPE: Record<string, Shape> = {
  repo: "stack",
  dir: "stack",
  folder: "stack",
  systems: "stack",
  screens: "stack",
  service: "pill",
  db: "drum",
  schema: "drum",
  table: "drum",
};
/** A system part's kind → its shape. */
const KIND: Record<string, Shape> = { s3: "drum", d1: "drum", kv: "drum", r2: "drum" };
export const shapeOf = (n: TreeNode): Shape =>
  SHAPE[n.role] ?? (n.kind ? KIND[n.kind] : undefined) ?? "rect";
const sketch = rough.generator();
const seedOf = (id: string) => {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % 2147483646 || 1;
};
/** Drum lid depth; the label moves down by it. */
export const lid = (h: number) => Math.min(8, h * 0.13);

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
    const open = shape === "zone";
    const W = w - 2 * m - (open ? 0 : STACK);
    const H = h - 2 * m - (open ? 0 : STACK);
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
    } else if (shape === "stack") {
      // Two sheets behind, offset down-right: it holds more.
      const back = (d: number) =>
        sketch.toPaths(sketch.rectangle(m + d, m + d, W, H, o)).map((q) => ({ ...q, back: true }));
      return [
        ...back(STACK),
        ...back(STACK / 2),
        ...sketch.toPaths(sketch.rectangle(m, m, W, H, o)),
      ];
    } else ds = [sketch.rectangle(m, m, W, H, o)];
    return ds.flatMap((d) => sketch.toPaths(d));
  }, [id, shape, w, h]);
  return (
    <svg className="sk" width={w} height={h} aria-hidden="true">
      {paths.map((p, i) => (
        <path
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed strokes of one shape
          key={i}
          d={p.d}
          className={`${p.fill && p.fill !== "none" ? "f" : "s"}${"back" in p ? " back" : ""}`}
        />
      ))}
    </svg>
  );
});

/** The box's second line: what it holds, or what it is. */
function subOf(n: TreeNode, fanIn: number): string {
  const what =
    n.tables !== undefined
      ? `${n.tables} table${n.tables === 1 ? "" : "s"}`
      : n.sub
        ? n.sub
        : n.kids.length
          ? `${n.files} file${n.files === 1 ? "" : "s"}`
          : n.role;
  return fanIn ? `${what} · ${fanIn} in` : what;
}

/** The kicker word: what kind of thing the box is. */
const KIND_WORD: Record<string, string> = {
  dir: "folder",
  db: "database",
  systems: "systems",
  screens: "screens",
};
const kindOf = (n: TreeNode) => n.kind ?? KIND_WORD[n.role] ?? n.role;
/** No kicker when it only says the name again (systems, screens, database). */
const kickOf = (n: TreeNode) => {
  const k = kindOf(n);
  return k === n.label.replace(/\/$/, "").toLowerCase() ? undefined : k;
};

/** Break after - . / only, never inside a word. */
const Label = ({ text }: { text: string }) => (
  <span className="label">
    {text.split(/(?<=[-./_])/).map((part, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed label
      <span key={i}>
        {part}
        <wbr />
      </span>
    ))}
  </span>
);

const Box = memo(function Box({ data }: NodeProps<Node<BoxData>>) {
  const { n, w, h, open } = data;
  const shape = open ? "zone" : shapeOf(n);
  const cls = [
    "box",
    `shape-${shape}`,
    `role-${n.role}`,
    open ? "zoned" : "",
    n.drift ? `drift-${n.drift}` : "",
    data.selected ? "sel" : "",
    data.dim ? "dim" : "",
  ].join(" ");
  return (
    <div
      className={cls}
      data-box={n.id}
      style={{
        width: w,
        height: h,
        ...(open ? { paddingTop: 10, height: h, justifyContent: "flex-start" } : {}),
        ...(open ? {} : { paddingRight: 14 + STACK, paddingBottom: 10 + STACK }),
        ...(shape === "drum" ? { paddingTop: 2 * lid(h) + 4 } : {}),
        ...(open
          ? {}
          : ({ "--fit": `${labelFit(n, w, h, shape === "drum" ? 16 : 0)}px` } as CSSProperties)),
      }}
      title={n.id}
    >
      <Sketch id={n.id} shape={shape} w={w} h={h} />
      <Handle type="target" position={Position.Left} className="h" />
      <div className="head" style={open ? { height: ZONE.top - 14 } : undefined}>
        {(kickOf(n) || open) && (
          <span className="kick">
            {kickOf(n)}
            {open && (
              <span className="sub">
                {kickOf(n) ? " · " : ""}
                {subOf(n, data.fanIn)}
              </span>
            )}
          </span>
        )}
        <Label text={n.label} />
        {n.line && <span className="desc">{n.line}</span>}
        {!open && <span className="sub">{subOf(n, data.fanIn)}</span>}
      </div>
      {data.folds && (
        <button
          type="button"
          className="fold"
          aria-label={open ? `Fold ${n.label}` : `Open ${n.label} in place`}
          onClick={(e) => {
            e.stopPropagation();
            data.onToggle(n.id, !open);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {open ? "−" : "+"}
        </button>
      )}
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

/** Labels grow as the view shrinks, so a wide map still reads at fit. */
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
  /** The box drawn as the canvas. */
  focus: string;
  fold: Fold;
  sel: string | undefined;
  onSelect(id: string | undefined): void;
  /** Open or fold a box in place. */
  onToggle(id: string, on: boolean): void;
}

/** A flat level fits no smaller than FIT_MIN, to keep labels readable; a frame with open boxes fits whole. */
const fitOf = (folded: boolean) => ({
  padding: 0.12,
  maxZoom: 1.6,
  minZoom: folded ? 0.04 : FIT_MIN,
});
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Canvas({ data, focus, fold, sel, onSelect, onToggle }: Props) {
  // The last laid-out frame stays until the next is ready.
  const [laid, setLaid] = useState<{ root: string; map: Shown }>();
  const rf = useRef<ReactFlowInstance<Node<BoxData>, Edge<LineData>>>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const marks = useMemo<Marks>(
    () => ({
      select: "[data-box]",
      key: (el) => (el as HTMLElement).dataset.box ?? null,
      fresh: ".react-flow__edge",
      units: () => 1 / (rf.current?.getZoom() ?? 1),
    }),
    [],
  );
  const pending = useRef<ReturnType<typeof snapshot> | null>(null);
  const shownRoot = useRef<string>(undefined);

  useEffect(() => {
    let live = true;
    const top = (n: TreeNode) => (shapeOf(n) === "drum" ? 16 : 0);
    shown(data, focus, fold, top).then((map) => {
      if (!live) return;
      // Same root: glide from where the boxes stand now.
      pending.current =
        shownRoot.current === focus && !reduced() ? snapshot(wrap.current, marks) : null;
      shownRoot.current = focus;
      setLaid({ root: focus, map });
    });
    return () => {
      live = false;
    };
  }, [data, focus, fold, marks]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per new frame
  useEffect(() => {
    const before = pending.current;
    pending.current = null;
    if (!before || !wrap.current) return;
    // xyflow writes positions a frame after the commit. Fit first: the glide starts from the old
    // screen spots, so one motion covers the move and the zoom.
    const el = wrap.current;
    let id = requestAnimationFrame(() => {
      const m = laid?.map;
      if (m && !data.levels[focus]?.grid)
        void rf.current?.fitView(fitOf(m.boxes.some((b) => b.open)));
      id = requestAnimationFrame(() => play({ before, next: el, marks }));
    });
    return () => cancelAnimationFrame(id);
  }, [laid, marks]);

  const map = laid?.map;
  const lines = useMemo(() => {
    if (!map) return [];
    const at = new Map(map.boxes.map((b) => [b.id, b]));
    return map.levels.flatMap((lv) => {
      const level = data.levels[lv.id];
      if (!level) return [];
      return level.edges.map((e, i) => {
        const route = lv.laid.extra?.[i];
        const a = at.get(e.from);
        const b = at.get(e.to);
        const points: [number, number][] = route?.length
          ? route.map(([x, y]) => [x + lv.x, y + lv.y])
          : a && b
            ? [
                [a.x + a.w / 2, a.y + a.h / 2],
                [b.x + b.w / 2, b.y + b.h / 2],
              ]
            : [];
        return {
          id: `${lv.id}#${i}`,
          ...e,
          points,
          grid: !route?.length,
          crowd: level.edges.length,
        };
      });
    });
  }, [map, data]);

  // Hover lights a box's lines as a selection does, without dimming the rest.
  const [hover, setHover] = useState<string>();
  const lit = sel ?? hover;
  const near = useMemo(() => {
    const s = new Set<string>();
    for (const e of lines) {
      if (e.from === sel) s.add(e.to);
      if (e.to === sel) s.add(e.from);
    }
    return s;
  }, [lines, sel]);

  const fanIn = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of Object.values(data.levels)) for (const b of l.boxes) m.set(b.id, b.fanIn);
    return m;
  }, [data]);
  const nodes = useMemo<Node<BoxData>[]>(
    () =>
      (map?.boxes ?? []).map((b) => {
        const n = data.nodes[b.id] as TreeNode;
        return {
          id: b.id,
          type: "box",
          position: { x: b.x, y: b.y },
          width: b.w,
          height: b.h,
          draggable: false,
          data: {
            n,
            w: b.w,
            h: b.h,
            open: b.open,
            folds: !!data.levels[b.id],
            fanIn: fanIn.get(b.id) ?? 0,
            selected: b.id === sel,
            dim: !!sel && b.id !== sel && !near.has(b.id) && !b.open,
            onToggle,
          },
        };
      }),
    [map, data, fanIn, sel, near, onToggle],
  );
  const edges = useMemo<Edge<LineData>[]>(
    () =>
      lines.flatMap((e) => {
        const hot = !!lit && (e.from === lit || e.to === lit);
        // A grid has no routed lines: the selected box's only, straight.
        if (e.grid && !hot) return [];
        return [
          {
            id: e.id,
            source: e.from,
            target: e.to,
            type: "line",
            ...(hot || e.crowd <= FAINT_OVER
              ? { markerEnd: { type: MarkerType.ArrowClosed, width: 11, height: 11 } }
              : {}),
            data: {
              points: e.points,
              n: e.n,
              type: e.type,
              hot,
              dim: !!sel && !hot,
              faint: !hot && e.crowd > FAINT_OVER,
            },
          },
        ];
      }),
    [lines, sel, lit],
  );

  // Arrows move the selection to the nearest box that way.
  useEffect(() => {
    const key = (ev: KeyboardEvent) => {
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
        ev.key
      ];
      if (!dir || (ev.target as HTMLElement).closest("input, textarea, select")) return;
      ev.preventDefault();
      const boxes = map?.boxes ?? [];
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
  }, [map, sel, onSelect]);

  const rootLevel = data.levels[focus];
  // A grid opens at its top, full width: the most used first, like a list.
  const onInit = useCallback(
    (inst: ReactFlowInstance<Node<BoxData>, Edge<LineData>>) => {
      rf.current = inst;
      if (!rootLevel?.grid || !map) return;
      const w = wrap.current?.clientWidth ?? 1000;
      const zoom = Math.min(1.1, Math.max(FIT_MIN, (w - 32) / map.w));
      inst.setViewport({ x: 16, y: 104, zoom });
    },
    [rootLevel, map],
  );

  if (!rootLevel) return <div className="canvas msg">Nothing inside {focus}.</div>;
  if (!laid || !map) return <div className="canvas msg">Laying out…</div>;
  const closed = map.boxes.filter((b) => !b.parent).length;
  return (
    <div className="canvas" ref={wrap}>
      {rootLevel.grid && map.boxes.every((b) => !b.open) && (
        <p className="hint">
          {rootLevel.edges.length
            ? `${closed} boxes in one folder: too flat for a graph. Sorted by fan-in; select a box to see its lines.`
            : `${closed} boxes, no lines between them, in their own order.`}
        </p>
      )}
      <ReactFlow
        key={laid.root}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView={!rootLevel.grid}
        fitViewOptions={fitOf(map.boxes.some((b) => b.open))}
        onInit={onInit}
        minZoom={0.02}
        maxZoom={2.5}
        nodesConnectable={false}
        nodesDraggable={false}
        elementsSelectable={false}
        onlyRenderVisibleElements
        onNodeClick={(_, n) => onSelect(n.id === sel ? undefined : n.id)}
        onNodeDoubleClick={(_, n) => data.levels[n.id] && onToggle(n.id, !n.data.open)}
        onPaneClick={() => onSelect(undefined)}
        onNodeMouseEnter={(_, n) => !n.data.open && setHover(n.id)}
        onNodeMouseLeave={() => setHover(undefined)}
      >
        <ZoomVar />
        {map.boxes.length > 12 && (
          <MiniMap
            pannable
            zoomable
            nodeClassName={(n) =>
              `mm role-${(n.data as BoxData).n.role}${(n.data as BoxData).open ? " mm-zone" : ""}`
            }
          />
        )}
      </ReactFlow>
    </div>
  );
}
