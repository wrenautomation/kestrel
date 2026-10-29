/** The adapter seam: one file per tool, each turns a repo into a Graph and a Graph into pages. */
import type { Section } from "../cache.js";
import type { Config, LayerId } from "../config.js";
import type { Graph } from "../graph.js";

export interface LayerContext {
  root: string;
  config: Config;
  env: NodeJS.ProcessEnv;
  /** A layer earlier in LAYER_IDS, as the current map holds it. */
  prior(layer: LayerId): Promise<Graph | null>;
}

export interface Layer {
  id: LayerId;
  /** Inputs per group (cache.ts). None or null: the layer runs whole on every gen. */
  sections?(ctx: LayerContext): Promise<Section[] | null>;
  /** `only`: extract just these groups; the rest stay as the current map holds them. */
  extract(ctx: LayerContext, only?: ReadonlySet<string>): Promise<Graph>;
  /** One group's page: Markdown with a Mermaid diagram, keyed by file name. */
  render(group: Graph): Record<string, string>;
}
