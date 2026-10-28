/**
 * What `kestrel view` sends the page: one tree over every layer, and a laid-out level per
 * container. The page runs no layout and no graph math; it draws a level and shows a detail.
 */
import type { Attrs } from "../graph.js";

export type Drift = "add" | "change" | "inside";

/** A box: a repo, a top folder, a package, a source folder or a file; the database, a schema or a table; the systems, a system or a part of one. */
export interface TreeNode {
  id: string;
  label: string;
  /** A graph role, or `dir` and `folder` for the folds kestrel adds. */
  role: string;
  parent?: string;
  kids: string[];
  /** Files under it; 1 for a file. */
  files: number;
  /** Tables and views under the database or a schema. */
  tables?: number;
  /** The box's second line when files or tables say nothing: a system's kind or part count. */
  sub?: string;
  drift?: Drift;
  /** Approved nodes under it that the current map no longer has. */
  removed?: string[];
  /** `none`: a required role with no card on it or under it. `stale`: a card on it is stale. */
  badge?: "none" | "stale";
}

/** An export or a route, shown in its file's detail. */
export interface Item {
  id: string;
  name: string;
  kind: string;
  /** Signature, or `input → output` for a route. */
  sig: string;
  inferred?: boolean;
  drift?: Drift;
}

export interface Service {
  id: string;
  name: string;
  kind: string;
  /** The file box it lives in. */
  box: string;
  routeCount: number;
  /** Filled in the file's own detail only; a folder lists services without their routes. */
  routes: Item[];
  drift?: Drift;
}

export interface Detail {
  attrs?: Attrs;
  /** Boxes outside it that it imports (a table: references), and the other way, with the edge count. */
  uses: Link[];
  usedBy: Link[];
  exports: Item[];
  services: Service[];
  /** A table's indexes: name, `index`, its CREATE statement. */
  indexes: Item[];
  /** A system's or part's own relations, each with the code on both ends. */
  seams: Seam[];
  /** The code a system or part names as its own. */
  code?: Path[];
  /** Exports with no declared type, for a package or folder: the count only. */
  inferred: number;
  exportCount: number;
  /** The cards that cover it, entity card first. */
  cards: CardRef[];
}

/** One relation of the systems model, seen from one end. */
export interface Seam {
  /** The box at the other end. */
  id: string;
  /** True: this box calls the other. */
  out: boolean;
  kind: string;
  titles: string[];
  /** Code at the source end, and at the target end. */
  here: Path[];
  there: Path[];
}

/** A code path the model names; `box` when it is a file the map has. */
export interface Path {
  path: string;
  box?: string;
}

export interface Link {
  /** The box at the other end, at the same depth as the node (a package to a package). */
  id: string;
  n: number;
  type: boolean;
}

export interface LevelBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fanIn: number;
}

export interface LevelEdge {
  from: string;
  to: string;
  /** File imports this edge stands for. */
  n: number;
  /** Every one is type-only. */
  type: boolean;
  /** Polyline from the layout, start to end. */
  points: [number, number][];
}

export interface Level {
  w: number;
  h: number;
  /** Too many boxes for a readable graph: a grid by fan-in, lines only for the selected box. */
  grid?: boolean;
  boxes: LevelBox[];
  edges: LevelEdge[];
}

/** Layouts by a hash of their input, so an unchanged level skips ELK. */
export type LayoutCache = Record<
  string,
  Pick<Level, "w" | "h" | "grid"> & {
    boxes: [string, number, number][];
    points: [number, number][][];
  }
>;

export interface ViewData {
  repo: string;
  root: string;
  /** False: no approved map yet, so no drift to show. */
  approved: boolean;
  nodes: Record<string, TreeNode>;
  details: Record<string, Detail>;
  /** Keyed by container id. */
  levels: Record<string, Level>;
  /** Every export and route, for search: name → the file box that shows it. */
  index: { name: string; kind: string; box: string }[];
  counts: Record<string, number>;
}

/** A card as the view shows it: `covers` are current node ids. */
export interface CardRef {
  path: string;
  type: string;
  why: string;
  stale: boolean;
}

export interface CardView extends CardRef {
  covers: string[];
}
