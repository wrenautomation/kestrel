/** `kestrel.json` at the repo root: which layers run and where their inputs are. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

export const LAYER_IDS = ["imports", "api", "routes", "schema", "systems"] as const;
export type LayerId = (typeof LAYER_IDS)[number];

export const Imports = z.object({
  /** Globs of workspace packages; each is one group. */
  packages: z.array(z.string()).default(["packages/*", "apps/*"]),
  /** Paths dependency-cruiser skips. */
  exclude: z
    .array(z.string())
    .default([
      "(^|/)(node_modules|dist|build|coverage|storybook-static)/",
      "\\.test\\.",
      "\\.stories\\.",
    ]),
});

const Api = z.object({
  packages: z.array(z.string()).default(["packages/*"]),
});

const Routes = z.object({
  packages: z.array(z.string()).default(["packages/*", "apps/*"]),
});

const Schema = z.object({
  /** Env var that holds a migrated Postgres URL (CI); the layer reads it, never prints it. */
  urlEnv: z.string().default("KESTREL_DB_URL"),
  /** Shell command that migrates an empty database; kestrel gives it the URL in `migrateUrlEnv`. */
  migrate: z.string().optional(),
  migrateUrlEnv: z.string().default("DATABASE_URL"),
  /** Folder of migration files; each `.sql` is a `migration` node. */
  migrations: z.string().optional(),
  image: z.string().default("postgres:17"),
  tbls: z.string().default("ghcr.io/k1low/tbls:v1.96.1"),
  /** Schemas to read; by default every one tbls finds, less `skip`. */
  schemas: z.array(z.string()).optional(),
  /** The migrator's own bookkeeping, not the app's shape. */
  skip: z.array(z.string()).default(["drizzle"]),
});

const Systems = z.object({
  /** The LikeC4 workspace: every `.c4` file under it. */
  dir: z.string().default("map/system"),
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

/** Reads and checks the config: `kestrel.json` under `root`, or a file given (relative to `root`). */
export async function loadConfig(root: string, file = "kestrel.json"): Promise<Config> {
  const text = await readFile(resolve(root, file), "utf8");
  return Config.parse(JSON.parse(text));
}
