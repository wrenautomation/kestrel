/** `kestrel.json` at the repo root: which layers run and where their inputs are. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const LAYER_IDS = ["imports", "api", "routes", "schema", "systems"] as const;
export type LayerId = (typeof LAYER_IDS)[number];

const Imports = z.object({
  /** Globs of workspace packages; each is one group. */
  packages: z.array(z.string()).default(["packages/*", "apps/*"]),
  /** Paths dependency-cruiser skips. */
  exclude: z.array(z.string()).default(["node_modules", "dist", "\\.test\\.", "\\.stories\\."]),
});

const Api = z.object({
  packages: z.array(z.string()).default(["packages/*"]),
});

const Routes = z.object({
  packages: z.array(z.string()).default(["packages/*", "apps/*"]),
});

const Schema = z.object({
  /** Env var that holds a migrated Postgres URL; the layer reads it, never prints it. */
  urlEnv: z.string().default("KESTREL_DB_URL"),
  schemas: z.array(z.string()).default(["public"]),
});

const Systems = z.object({
  /** LikeC4 model files. */
  model: z.array(z.string()).default(["map/system/*.c4"]),
});

const Cards = z.object({
  dir: z.string().default("map"),
  /** Roles that must each have a card. */
  require: z.array(z.string()).default(["package", "table", "system"]),
});

export const Config = z.object({
  out: z.string().default("map/generated"),
  layers: z
    .object({
      imports: Imports.optional(),
      api: Api.optional(),
      routes: Routes.optional(),
      schema: Schema.optional(),
      systems: Systems.optional(),
    })
    .default({}),
  cards: Cards.optional(),
});
export type Config = z.infer<typeof Config>;

/** Reads and checks `kestrel.json` under `root`. */
export async function loadConfig(root: string): Promise<Config> {
  const text = await readFile(join(root, "kestrel.json"), "utf8");
  return Config.parse(JSON.parse(text));
}
