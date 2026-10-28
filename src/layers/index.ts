import type { LayerId } from "../config.js";
import { api } from "./api.js";
import { imports } from "./imports.js";
import type { Layer } from "./layer.js";
import { routes } from "./routes.js";
import { schema } from "./schema.js";
import { systems } from "./systems.js";

export const LAYERS: Record<LayerId, Layer> = { imports, api, routes, schema, systems };
export type { Layer, LayerContext } from "./layer.js";
