/** `kestrel.json` at the repo root: which layers run and where their inputs are. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

/** Gen order: a layer reads only those before it (routes reads schema's tables). */
export const LAYER_IDS = ["imports", "api", "schema", "routes", "systems", "ui"] as const;
export type LayerId = (typeof LAYER_IDS)[number];

export const Imports = z.object({
  /** Globs of workspace packages; each is one group. */
  packages: z.array(z.string()).default(["packages/*", "apps/*"]),
  /**
   * Paths dependency-cruiser skips; a match drops the import too, so never a path in node_modules
   * (a package's `dist/`): `doNotFollow` stops the walk there.
   */
  exclude: z
    .array(z.string())
    .default([
      "^(?!node_modules/)(dist|build|coverage|storybook-static|.*/(dist|build|coverage|storybook-static))/",
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
  /** Files the schema comes from, beyond the migrations folder: gen runs the layer when one changes. */
  inputs: z.array(z.string()).default([]),
  /** The migrator's own bookkeeping, not the app's shape. */
  skip: z.array(z.string()).default(["drizzle"]),
});

const Map_ = z.record(z.string(), z.string()).default({});

/** The residue: what deploy files and code cannot say (see layers/systems.ts). */
const Systems = z.object({
  wrangler: z.array(z.string()).default(["**/wrangler.toml"]),
  terraform: z.array(z.string()).default([]),
  compose: z.array(z.string()).default([]),
  /** Deploy files that carry `# @unit [kind:]name: one line` tags. */
  tags: z.array(z.string()).default([]),
  /** Deploy file glob → host unit key its units run on. */
  hosts: Map_,
  /** Unit key → its entry file, the root of its bundle. */
  entries: Map_,
  /** Sibling repo id → its dir from the root. */
  repos: Map_,
  /** Package dirs inside a repo, for npm names and deps. */
  packages: z.array(z.string()).default(["packages/*", "apps/*"]),
  vendors: z
    .record(z.string(), z.object({ title: z.string(), description: z.string().optional() }))
    .default({}),
  /** Env var → target id. */
  env: Map_,
  /** Import specifier or prefix → target id. */
  imports: Map_,
  /** Settings file and a regex with groups (key, env var), so a settings alias counts as its env var. */
  settings: z.object({ file: z.string(), pattern: z.string() }).optional(),
  /** Unit key that invokes Restate services. */
  restate: z.string().optional(),
  /** Id → one-liner, where no file gives one. */
  describe: Map_,
});
export type SystemsConfig = z.infer<typeof Systems>;

const Ui = z.object({
  /** Shell command, run in the repo root, that prints the screens as JSON (see layers/ui.ts). */
  dump: z.string(),
  /** Globs of CSF story files. */
  stories: z
    .array(z.string())
    .default(["packages/*/src/**/*.stories.tsx", "apps/*/web/src/**/*.stories.tsx"]),
  /** Files the dump reads, over the ones the dump names (layers/ui.ts); stories count too. */
  inputs: z.array(z.string()).optional(),
  /** The web's api client functions: `<fn>("<service>/<route>")` is a screen's call (layers/ui.ts). */
  calls: z.array(z.string()).default(["call"]),
  /** The function a record kind is declared with: `<fn>({id, view})` (layers/ui.ts). */
  records: z.string().optional(),
  /** The function a page story is made with: `export const X = <fn>("/path", …)` (layers/ui.ts). */
  pages: z.string().optional(),
  /** A pattern on a page story's call: a match signs in to the team workspace, else a client's. */
  team: z.string().optional(),
  /** The Storybook that serves the stories, for the view's live screen: `http://localhost:6006`. */
  storybook: z.string().optional(),
});

const Health = z.object({
  /** Package scopes the repo owns elsewhere (`@wrenautomation/`): health counts how far each pin is behind. */
  pins: z.array(z.string()).default([]),
  /** Folders jscpd reads. */
  paths: z.array(z.string()).default(["packages", "apps"]),
  ignore: z
    .array(z.string())
    .default([
      "**/node_modules/**",
      "**/dist/**",
      "**/storybook-static/**",
      "**/test/**",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.stories.tsx",
    ]),
});

const Cost = z.object({
  /** Prints the spend lines as JSON (`CostDump` in cost.ts), run in the repo root. */
  dump: z.string(),
  /** `source:key` → node id, for what code cannot tell: `"aws:AWS Lambda": "system:wren.worker"`. */
  owners: z.record(z.string(), z.string()).default({}),
  /** A pattern whose group 1 is a part name in the code: the part's spend goes to its package. */
  parts: z.string().optional(),
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
      ui: Ui.optional(),
    })
    .default({}),
  cards: Cards.optional(),
  health: Health.default(Health.parse({})),
  cost: Cost.optional(),
});
export type Config = z.infer<typeof Config>;

/** Reads and checks the config: `kestrel.json` under `root`, or a file given (relative to `root`). */
export async function loadConfig(root: string, file = "kestrel.json"): Promise<Config> {
  const text = await readFile(resolve(root, file), "utf8");
  return Config.parse(JSON.parse(text));
}
