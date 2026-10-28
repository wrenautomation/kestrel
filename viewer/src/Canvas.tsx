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

const Box = memo(function Box({ data }: NodeProps<Node<BoxData>>) {
  const { n, box } = data;
  const cls = [
    "box",
    `role-${n.role}`,
    n.drift ? `drift-${n.drift}` : "",
    data.selected ? "sel" : "",
    data.dim ? "dim" : "",
  ].join(" ");
  return (
    <div className={cls} style={{ width: box.w, height: box.h }} title={n.id}>
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
          dim: !!sel && b.id !== sel && !near.has(b.id),
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
          {level.boxes.length} boxes in one folder: too flat for a graph. Sorted by fan-in; select a
          box to see its lines.
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
