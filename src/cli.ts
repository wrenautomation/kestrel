#!/usr/bin/env node
/**
 * kestrel gen [layer...]      extract, write current + pages
 * kestrel check [layer...]    gen, then fail on drift vs approved
 * kestrel approve [layer...]  current → approved for the whole map (commit it: that is the approval)
 * kestrel stamp <card...>     mark cards read against the approved graph
 * kestrel view                the map as a local page: zoom, details, drift, notes
 * kestrel health              signals: cycles, flat folders, fan, weak interfaces, clones, unused
 * kestrel cost                spend per node, from the repo's dump; local only, never committed
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Command } from "commander";
import {
  checkCards,
  coveredBy,
  formatIssues,
  indexOf,
  readCards,
  restamp,
  stampOf,
} from "./cards.js";
import { type Config, LAYER_IDS, type LayerId, loadConfig } from "./config.js";
import {
  attribute,
  type Cost,
  CostDump,
  page as costPage,
  type Measures,
  partOwners,
} from "./cost.js";
import { diff, formatChanges } from "./diff.js";
import { byGroup } from "./graph.js";
import { fromGraphs, page as healthPage, runTools } from "./health.js";
import { LAYERS } from "./layers/index.js";
import { seams } from "./layers/systems.js";
import { fileStore } from "./store.js";
import { buildView } from "./view/build.js";
import { serve } from "./view/serve.js";
import type { LayoutCache } from "./view/types.js";

export interface RunOptions {
  root: string;
  /** Empty = every layer that has a block in `kestrel.json`. */
  layers: LayerId[];
  /** Config file, if not `<root>/kestrel.json`. */
  config?: string;
}

const chosen = (config: Config, asked: LayerId[]): LayerId[] =>
  asked.length ? asked : LAYER_IDS.filter((id) => config.layers[id]);

export async function gen(opts: RunOptions): Promise<void> {
  const config = await loadConfig(opts.root, opts.config);
  const store = fileStore(opts.root, config.out);
  for (const id of chosen(config, opts.layers)) {
    const layer = LAYERS[id];
    const g = await layer.extract({ root: opts.root, config, env: process.env });
    await store.write(id, "current", g);
    const pages: Record<string, string> = {};
    for (const part of byGroup(g).values()) Object.assign(pages, layer.render(part));
    await store.writePages(id, pages);
    console.log(`${id}: ${g.nodes.length} nodes, ${g.edges.length} edges`);
  }
}

/** Exit code: 0 clean, 1 drift or nothing approved yet. */
export async function check(opts: RunOptions): Promise<number> {
  await gen(opts);
  const config = await loadConfig(opts.root, opts.config);
  const store = fileStore(opts.root, config.out);
  let code = 0;
  for (const id of chosen(config, opts.layers)) {
    const [approved, current] = await Promise.all([
      store.read(id, "approved"),
      store.read(id, "current"),
    ]);
    if (!approved) {
      console.error(
        `${id}: nothing approved yet. Review ${config.out}/${id}/, then run kestrel approve.`,
      );
      code = 1;
      continue;
    }
    const changes = diff(approved, current ?? { layer: id, nodes: [], edges: [] });
    if (!changes.length) continue;
    console.error(
      `${id}: ${changes.length} changes since the approved map\n${formatChanges(changes)}`,
    );
    code = 1;
  }
  if (code) console.error("\nReview the changes. If they are right: kestrel approve, then commit.");
  const model = config.layers.systems && (await store.read("systems", "current"));
  const gone = model ? await seams(opts.root, model) : [];
  if (gone.length) {
    console.error(
      `\nsystems: ${gone.length} code paths the model names are gone\n  ${gone.join("\n  ")}`,
    );
    console.error(`Fix the paths in ${config.layers.systems?.dir}.`);
    code = 1;
  }
  if (config.cards) {
    const cards = await readCards(opts.root, config.cards.dir);
    const ix = indexOf(await approvedGraphs(store));
    const all = await checkCards(
      opts.root,
      cards,
      ix,
      config.cards.require,
      await measures(opts.root, config.out),
    );
    const unmeasured = all.filter((i) => i.rule === "unmeasured");
    if (unmeasured.length)
      console.error(`\ntriggers: ${unmeasured.length} not measured\n${formatIssues(unmeasured)}`);
    const issues = all.filter((i) => i.rule !== "unmeasured");
    if (issues.length) {
      console.error(`\ncards: ${issues.length} issues\n${formatIssues(issues)}`);
      console.error("Read each stale card against the map, fix it, then: kestrel stamp <card>.");
      code = 1;
    }
  }
  return code;
}

export async function approve(opts: RunOptions): Promise<void> {
  const config = await loadConfig(opts.root, opts.config);
  const store = fileStore(opts.root, config.out);
  for (const id of chosen(config, opts.layers)) {
    const changed = await store.approve(id);
    console.log(`${id}: ${changed.length ? `approved ${changed.length} groups` : "no change"}`);
  }
}

const readJson = <T>(file: string): Promise<T | null> =>
  readFile(file, "utf8").then(
    (t) => JSON.parse(t) as T,
    () => null,
  );

/** What the stored reports measure, for decision triggers: nothing is run. */
async function measures(root: string, out: string): Promise<Measures> {
  return {
    cost: await readJson<Cost>(resolve(root, out, "cost.current.json")),
    health: await readJson<Measures["health"]>(resolve(root, out, "health.current.json")),
  };
}

const run = promisify(execFile);

/** Runs the repo's cost dump (or reuses the stored lines) and gives each line its owner. */
export async function cost(root: string, o: { dump: boolean; config?: string }): Promise<Cost> {
  const config = await loadConfig(root, o.config);
  const c = config.cost;
  if (!c) throw new Error("cost: no `cost` in kestrel.json");
  const file = resolve(root, config.out, "cost.current.json");
  let dump: CostDump;
  if (o.dump) {
    const { stdout } = await run("sh", ["-c", c.dump], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    dump = CostDump.parse(JSON.parse(stdout));
  } else {
    const was = await readJson<Cost>(file);
    if (!was) throw new Error("cost: nothing stored; run kestrel cost first");
    dump = CostDump.parse(was);
  }
  const imports = await fileStore(root, config.out).read("imports", "current");
  const parts = c.parts && imports ? await partOwners(root, imports, c.parts) : new Map();
  const out = attribute(dump, c.owners, parts);
  await writeFile(file, `${JSON.stringify(out, null, 2)}\n`);
  await writeFile(resolve(root, config.out, "cost.md"), costPage(out));
  return out;
}

const approvedGraphs = async (store: ReturnType<typeof fileStore>) =>
  (await Promise.all(LAYER_IDS.map((id) => store.read(id, "approved")))).filter((g) => g !== null);

export async function stamp(root: string, cards: string[], file?: string): Promise<void> {
  const config = await loadConfig(root, file);
  const all = await readCards(root, config.cards?.dir ?? "map");
  const ix = indexOf(await approvedGraphs(fileStore(root, config.out)));
  const asked = cards.map((p) => resolve(root, p));
  const found = all.filter((c) => asked.includes(resolve(root, c.path)));
  if (found.length < asked.length) throw new Error("a path given is not a card (no frontmatter)");
  for (const c of found) {
    await restamp(root, c, ix);
    console.log(`${c.path}: stamp ${stampOf(c, ix)}, covers ${coveredBy(c, ix).length} nodes`);
  }
}

/** The view's data from what is on disk: run `gen` first. */
export async function viewData(root: string, configFile?: string) {
  const config = await loadConfig(root, configFile);
  const store = fileStore(root, config.out);
  const current: Record<string, Awaited<ReturnType<typeof store.read>>> = {};
  const approved: typeof current = {};
  for (const id of LAYER_IDS) {
    current[id] = await store.read(id, "current");
    approved[id] = await store.read(id, "approved");
  }
  if (!Object.values(current).some(Boolean))
    throw new Error(`no map under ${config.out}; run kestrel gen first`);
  // Babel's and ESLint's spot: never committed, and gone with a clean install.
  const file = resolve(root, "node_modules/.cache/kestrel/view.json");
  const cache: LayoutCache = await readFile(file, "utf8")
    .then((t) => JSON.parse(t) as LayoutCache)
    .catch(() => ({}));
  const cards = config.cards ? await readCards(root, config.cards.dir) : [];
  const was = indexOf(Object.values(approved).filter((g) => g !== null));
  const now = indexOf(Object.values(current).filter((g) => g !== null));
  const view = await buildView({
    root,
    current,
    approved,
    cache,
    cards: cards.map((c) => ({
      path: c.path,
      type: c.type ?? "card",
      why: c.why,
      stale: Boolean(c.stamp && c.stamp !== stampOf(c, was)),
      covers: coveredBy(c, now),
    })),
    require: config.cards?.require ?? [],
    cost: await readJson<Cost>(resolve(root, config.out, "cost.current.json")),
  });
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(cache));
  return view;
}

function layerArgs(args: string[]): LayerId[] {
  for (const a of args)
    if (!(LAYER_IDS as readonly string[]).includes(a))
      throw new Error(`unknown layer ${a}; one of ${LAYER_IDS.join(", ")}`);
  return args as LayerId[];
}

export function program(): Command {
  const p = new Command("kestrel")
    .description("Review the design, not the code.")
    .option("-C, --root <dir>", "repo root", ".")
    .option("-c, --config <file>", "config file, if not <root>/kestrel.json");
  const root = () => resolve(p.opts<{ root: string }>().root);
  const cfg = () => {
    const c = p.opts<{ config?: string }>().config;
    return c ? { config: resolve(c) } : {};
  };
  p.command("gen")
    .argument("[layers...]")
    .description("write the current map and its pages")
    .action(async (args: string[]) => gen({ root: root(), layers: layerArgs(args), ...cfg() }));
  p.command("check")
    .argument("[layers...]")
    .description("gen, then fail on drift from the approved map")
    .action(async (args: string[]) => {
      process.exitCode = await check({ root: root(), layers: layerArgs(args), ...cfg() });
    });
  p.command("approve")
    .argument("[layers...]")
    .description("make the current map the approved one; commit the result")
    .action(async (args: string[]) => approve({ root: root(), layers: layerArgs(args), ...cfg() }));
  p.command("stamp")
    .argument("<cards...>")
    .description("mark cards read against the approved map")
    .action(async (cards: string[]) => stamp(root(), cards, cfg().config));
  p.command("health")
    .description("write the health report; run it under the repo's check lock")
    .option("--no-tools", "graph signals only, no jscpd or knip")
    .option("--json", "print the report as JSON")
    .action(async (o: { tools: boolean; json?: boolean }) => {
      const r = root();
      const config = await loadConfig(r, cfg().config);
      const store = fileStore(r, config.out);
      const h = {
        ...fromGraphs(await store.read("imports", "current"), await store.read("api", "current")),
        ...(o.tools ? await runTools(r, config.health) : {}),
      };
      const dir = resolve(r, config.out);
      await writeFile(resolve(dir, "health.current.json"), `${JSON.stringify(h, null, 2)}\n`);
      await writeFile(resolve(dir, "health.md"), healthPage(h));
      if (o.json) console.log(JSON.stringify(h));
      else
        console.log(
          `health: ${h.cycles.length} file cycles, ${h.flat.length} flat folders` +
            (h.duplicates ? `, ${h.duplicates.percent}% duplicated` : "") +
            (h.unused ? `, ${h.unused.exports.length} unused exports` : ""),
        );
    });
  p.command("cost")
    .description("write the cost report from the repo's dump; local only, never commit it")
    .option("--no-dump", "reuse the stored lines; only the owners are read again")
    .action(async (o: { dump: boolean }) => {
      const c = await cost(root(), { dump: o.dump, ...cfg() });
      const total = c.lines.reduce((n, l) => n + l.usd, 0);
      const none = c.lines.filter((l) => !l.owner);
      console.log(
        `cost: $${total.toFixed(2)} over ${c.days} days, ${none.length} lines with no owner` +
          ` ($${none.reduce((n, l) => n + l.usd, 0).toFixed(2)})`,
      );
    });
  p.command("view")
    .description("open the map as a local page")
    .option("-p, --port <n>", "port", "4610")
    .option("--devboard <url>", "Devboard canvas server, for notes", "http://127.0.0.1:3100")
    .option("--dump <file>", "write the page's data to a file and exit")
    .action(async (o: { port: string; devboard: string; dump?: string }) => {
      const r = root();
      if (o.dump) {
        await writeFile(o.dump, JSON.stringify(await viewData(r, cfg().config)));
        return;
      }
      const url = await serve({
        port: Number(o.port),
        devboard: o.devboard,
        data: () => viewData(r, cfg().config),
      });
      console.log(`kestrel view: ${url}  (Ctrl-C stops it)`);
    });
  return p;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === self) await program().parseAsync();
