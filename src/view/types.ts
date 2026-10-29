/**
 * What `kestrel view` sends the page: one tree over every layer, and each container's kids with
 * their lifted lines. The page lays out the shown levels (orrery `nest`) and shows a detail.
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
  /** One line on what it is for, from code: package.json, a header comment, a deploy file. */
  line?: string;
  /** A system part's kind: `container`, `s3`, `worker`. Picks its shape. */
  kind?: string;
  /** Place among its siblings when the layer gives one (an app's pages in tab order). */
  order?: number;
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
  /** A route: the patterns it breaks. */
  breaks?: string[];
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
  /** A file's pages: the screen boxes drawn in it. */
  screens?: string[];
  /** A file's stories: the stories that show it alone. */
  stories?: StoryRef[];
  /** The cards that cover it, entity card first. */
  cards: CardRef[];
  /** A screen's routes, tables and outside (view/slice.ts). */
  slice?: Slice;
  /** A pattern: how many routes hold it, and each that breaks it. */
  pattern?: { holds: number; breaks: { route: string; box?: string }[] };
  /** What it cost to run over `days`, from `kestrel cost`: its own lines only. */
  cost?: { usd: number; days: number; lines: { source: string; key: string; usd: number }[] };
}

/** What a screen calls and what is behind it (view/slice.ts). */
export interface Slice {
  calls: SliceCall[];
  tables: SliceItem[];
  outside: SliceItem[];
  /** Call literals no route answers: the service has no such route, or no service has the prefix. */
  missing?: string[];
  host?: string[];
  /** Storybook ids of the page stories that open it. */
  stories?: string[];
}

export interface SliceCall {
  /** `route:<Service>/<handler>`. */
  id: string;
  name: string;
  /** The file box its service is registered in. */
  box?: string;
  /** Files the call is written in. */
  at: string[];
  /** The client path written: what a story's call log names. */
  path?: string;
  /** Over a quarter of the sliced screens call it. */
  shared?: true;
}

export interface SliceItem {
  /** A table or system box id, or `npm:<pkg>`, `host:<host>`. */
  id: string;
  label: string;
  kind: "reads" | "writes" | "system" | "npm" | "host";
  box?: string;
  /** The routes (or the screen itself, for a record's view) that reach it. */
  via: string[];
  shared?: true;
}

/** A story as a file's detail lists it; `box` is the story file's own box. */
export interface StoryRef {
  id: string;
  title: string;
  file: string;
  box?: string;
}

/** One relation of the systems model, seen from one end. */
export interface Seam {
  /** The box at the other end. */
  id: string;
  /** True: this box calls the other. */
  out: boolean;
  kind: string;
  titles: string[];
  /** Code at the source end that makes the link. */
  here: Path[];
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
  fanIn: number;
}

/** A line between two kids of one container: every import (or key, call) below them, lifted. */
export interface LevelEdge {
  from: string;
  to: string;
  /** File imports this edge stands for. */
  n: number;
  /** Every one is type-only. */
  type: boolean;
  /** Another path joins the two (reduce.ts): left out of the layout, drawn only when selected. */
  implied?: true;
}

/** A container's kids, in draw order, and the lines between them. No positions: the page lays out. */
export interface Level {
  /** Too many boxes, or no lines: a grid in this order (by fan-in), lines only for the selected box. */
  grid?: boolean;
  boxes: LevelBox[];
  edges: LevelEdge[];
}

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
  /** The Storybook that serves the page stories (`layers.ui.storybook`). */
  storybook?: string;
  /** Package name → its repo dir (`apps/portal/`), longest dir first: a path to its file box. */
  dirs?: [string, string][];
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
