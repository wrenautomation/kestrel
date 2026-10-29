#!/usr/bin/env node
/**
 * kestrel gen [layer...]      extract what changed (cache.ts), write current + pages; --fresh: all
 * kestrel watch [layer...]    gen on every save from a warm project; --view serves the map live
 * kestrel check [layer...]    gen, then fail on drift vs approved
 * kestrel approve [layer...]  current → approved for the whole map (commit it: that is the approval)
 * kestrel stamp <card...>     mark cards read against the approved graph
 * kestrel view                the map as a local page: zoom, details, drift, notes
 * kestrel health              signals: cycles, flat folders, fan, weak interfaces, clones, unused
 * kestrel packet [layer...]   what the last gen changes against approved, as one page
 * kestrel cost                spend per node, from the repo's dump; local only, never committed
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Command } from "commander";
import { cache, keysOf } from "./cache.js";
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
import { byGroup, type Graph, merge, normalize } from "./graph.js";
import { fromGraphs, page as healthPage, runTools } from "./health.js";
import { LAYERS } from "./layers/index.js";
import { seams } from "./layers/systems.js";
import { packages, tsProject } from "./layers/workspace.js";
import { packet } from "./packet.js";
import { fileStore } from "./store.js";
import { buildView } from "./view/build.js";
import { serve } from "./view/serve.js";
import { watch as watchFiles } from "./watch.js";

export interface RunOptions {
  root: string;
  /** Empty = every layer that has a block in `kestrel.json`. */
  layers: LayerId[];
  /** Config file, if not `<root>/kestrel.json`. */
  config?: string;
}

const chosen = (config: Config, asked: LayerId[]): LayerId[] =>
  asked.length ? asked : LAYER_IDS.filter((id) => config.layers[id]);

export interface GenResult {
  layer: LayerId;
  /** Groups extracted again; `all` = the whole layer, 0 = cache hit. */
  ran: number | "all";
  nodes: number;
  edges: number;
  ms: number;
}

/** `fresh`: ignore the cache, extract every layer whole. */
export async function gen(opts: RunOptions & { fresh?: boolean }): Promise<GenResult[]> {
  const config = await loadConfig(opts.root, opts.config);
  const store = fileStore(opts.root, config.out);
  const memo = cache(opts.root);
  const out: GenResult[] = [];
  for (const id of chosen(config, opts.layers)) {
    const layer = LAYERS[id];
    const t0 = Date.now();
    const lap = (what: string) =>
      process.env.KESTREL_TRACE && console.error(`  ${id} ${what} +${Date.now() - t0} ms`);
    const ctx = {
      root: opts.root,
      config,
      env: process.env,
      prior: (l: LayerId) => store.read(l, "current"),
    };
    const current = await store.read(id, "current");
    const sections = layer.sections && !opts.fresh ? await layer.sections(ctx) : null;
    const keys = sections?.length
      ? await keysOf(
          opts.root,
          sections,
          `${await codeOf(id)}\n${JSON.stringify(config.layers[id])}\n${await lockOf(opts.root)}`,
        )
      : null;
    const plan = keys ? await memo.plan(id, keys, current) : null;
    lap("keys");
    if (plan && current && plan.only?.size === 0 && !plan.gone.size) {
      out.push({
        layer: id,
        ran: 0,
        nodes: current.nodes.length,
        edges: current.edges.length,
        ms: Date.now() - t0,
      });
      continue;
    }
    const only = plan?.only && current ? plan.only : undefined;
    const fresh =
      only?.size === 0 ? { layer: id, nodes: [], edges: [] } : await layer.extract(ctx, only);
    lap("extract");
    const g =
      only && current ? splice(current, fresh, new Set([...only, ...(plan?.gone ?? [])])) : fresh;
    await store.write(id, "current", g);
    const pages: Record<string, string> = {};
    for (const part of byGroup(normalize(g)).values()) Object.assign(pages, layer.render(part));
    await store.writePages(id, pages);
    if (keys) await memo.save(id, keys, normalize(g));
    out.push({
      layer: id,
      ran: only ? only.size : "all",
      nodes: g.nodes.length,
      edges: g.edges.length,
      ms: Date.now() - t0,
    });
  }
  return out;
}

/** The layers that say their inputs: watch reruns only those unless told. */
async function cached(root: string, config: Config, ids: LayerId[]): Promise<LayerId[]> {
  const ctx = { root, config, env: process.env, prior: async () => null };
  const out: LayerId[] = [];
  for (const id of ids) if ((await LAYERS[id].sections?.(ctx))?.length) out.push(id);
  return out;
}

/** The lockfile: a dependency's new version can change imports and types in every layer. */
const lockOf = async (root: string) =>
  (
    await Promise.all(
      ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock"].map((f) =>
        readFile(resolve(root, f), "utf8").catch(() => ""),
      ),
    )
  ).join("\0");

/** The adapter's own code: a new kestrel build is a new key, whatever the version says. */
const codeOf = async (id: LayerId) =>
  (
    await Promise.all(
      [`./layers/${id}.js`, "./layers/workspace.js", "./graph.js"].map((f) =>
        readFile(new URL(f, import.meta.url), "utf8").catch(() => f),
      ),
    )
  ).join("\n");

/** `was` with `redo` groups replaced by `fresh`; a group `fresh` also gives is replaced too. */
function splice(was: Graph, fresh: Graph, redo: Set<string>): Graph {
  for (const n of fresh.nodes) redo.add(n.group);
  const keep = byGroup(was);
  for (const g of redo) keep.delete(g);
  return merge(was.layer, [...keep.values(), fresh]);
}

const line = (r: GenResult) =>
  `${r.layer}: ${r.nodes} nodes, ${r.edges} edges` +
  (r.ran === "all" ? "" : r.ran ? `, ${r.ran} groups again` : ", unchanged") +
  `, ${r.ms} ms`;

/** Exit code: 0 clean, 1 drift or nothing approved yet. */
export async function check(opts: RunOptions): Promise<number> {
  for (const r of await gen(opts)) console.log(line(r));
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
      `\nsystems: ${gone.length} code paths the map names are gone\n  ${gone.join("\n  ")}`,
    );
    console.error("Fix `entries` in kestrel.json `layers.systems`.");
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
  const cards = config.cards ? await readCards(root, config.cards.dir) : [];
  const was = indexOf(Object.values(approved).filter((g) => g !== null));
  const now = indexOf(Object.values(current).filter((g) => g !== null));
  const view = await buildView({
    root,
    current,
    approved,
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
    .option("--fresh", "ignore the cache: extract every layer whole")
    .action(async (args: string[], o: { fresh?: boolean }) => {
      for (const r of await gen({
        root: root(),
        layers: layerArgs(args),
        fresh: o.fresh === true,
        ...cfg(),
      }))
        console.log(line(r));
    });
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
  p.command("packet")
    .argument("[layers...]")
    .description("write what the last gen changes against the approved map, as one page")
    .option("-o, --out <file>", "write the page here, not to stdout")
    .action(async (args: string[], o: { out?: string }) => {
      const r = root();
      const config = await loadConfig(r, cfg().config);
      const store = fileStore(r, config.out);
      const ids = chosen(config, layerArgs(args));
      const layers = await Promise.all(
        ids.map(async (id) => ({
          id,
          approved: await store.read(id, "approved"),
          current: await store.read(id, "current"),
        })),
      );
      const graphs = (k: "approved" | "current") =>
        layers.map((l) => l[k]).filter((g) => g !== null);
      const page = packet({
        layers,
        cards: config.cards ? await readCards(r, config.cards.dir) : [],
        was: indexOf(graphs("approved")),
        now: indexOf(graphs("current")),
        measures: await measures(r, config.out),
      });
      if (o.out) await writeFile(resolve(r, o.out), page);
      else process.stdout.write(page);
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
      const { url } = await serve({
        port: Number(o.port),
        devboard: o.devboard,
        data: () => viewData(r, cfg().config),
      });
      console.log(`kestrel view: ${url}  (Ctrl-C stops it)`);
    });
  p.command("watch")
    .argument("[layers...]")
    .description("gen on every save, from a warm project; --view serves the map live")
    .option("--view", "also serve the map; open pages reload after each run")
    .option("-p, --port <n>", "port for --view", "4610")
    .option("--devboard <url>", "Devboard canvas server, for notes", "http://127.0.0.1:3100")
    .action(async (args: string[], o: { view?: boolean; port: string; devboard: string }) => {
      const r = root();
      const config = await loadConfig(r, cfg().config);
      // A layer with no inputs runs whole: on every save only if named.
      const asked = layerArgs(args);
      const ids = asked.length ? asked : await cached(r, config, chosen(config, []));
      const once = async () => {
        const t = Date.now();
        const rs = await gen({ root: r, layers: ids, ...cfg() });
        const moved = rs.filter((x) => x.ran !== 0);
        console.log(
          `${new Date().toTimeString().slice(0, 8)} ${Date.now() - t} ms` +
            (moved.length ? `: ${moved.map(line).join("; ")}` : ": no change"),
        );
        return moved.length > 0;
      };
      await once();
      // Parse and bind now, so the first save pays only for what it changed.
      if (ids.includes("api") || ids.includes("routes")) {
        const globs = [config.layers.api?.packages, config.layers.routes?.packages].flatMap(
          (g) => g ?? [],
        );
        tsProject(r, await packages(r, globs)).getTypeChecker();
      }
      const live = o.view
        ? await serve({
            port: Number(o.port),
            devboard: o.devboard,
            data: () => viewData(r, cfg().config),
            live: true,
          })
        : undefined;
      watchFiles({
        root: r,
        ignore: [`${config.out}/`],
        run: async () => {
          if ((await once()) && live) live.changed();
        },
      });
      console.log(
        `kestrel watch: ${ids.join(", ")}${live ? `, map at ${live.url}` : ""}  (Ctrl-C stops it)`,
      );
    });
  return p;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === self) await program().parseAsync();
