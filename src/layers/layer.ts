/** The adapter seam: one file per tool, each turns a repo into a Graph and a Graph into pages. */
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
  extract(ctx: LayerContext): Promise<Graph>;
  /** One group's page: Markdown with a Mermaid diagram, keyed by file name. */
  render(group: Graph): Record<string, string>;
}
