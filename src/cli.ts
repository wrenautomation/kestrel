#!/usr/bin/env node
/**
 * kestrel gen [layer...]      extract, write current + pages
 * kestrel check [layer...]    gen, then fail on drift vs approved
 * kestrel approve [layer...]  current → approved for the whole map (commit it: that is the approval)
 * kestrel stamp <card...>     mark cards read against the approved graph (step 4)
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { readCards, restamp } from "./cards.js";
import { type Config, LAYER_IDS, type LayerId, loadConfig } from "./config.js";
import { diff, formatChanges } from "./diff.js";
import { byGroup } from "./graph.js";
import { LAYERS } from "./layers/index.js";
import { fileStore } from "./store.js";

export interface RunOptions {
  root: string;
  /** Empty = every layer that has a block in `kestrel.json`. */
  layers: LayerId[];
}

const chosen = (config: Config, asked: LayerId[]): LayerId[] =>
  asked.length ? asked : LAYER_IDS.filter((id) => config.layers[id]);

export async function gen(opts: RunOptions): Promise<void> {
  const config = await loadConfig(opts.root);
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
  const config = await loadConfig(opts.root);
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
  return code;
}

export async function approve(opts: RunOptions): Promise<void> {
  const config = await loadConfig(opts.root);
  const store = fileStore(opts.root, config.out);
  for (const id of chosen(config, opts.layers)) {
    const changed = await store.approve(id);
    console.log(`${id}: ${changed.length ? `approved ${changed.length} groups` : "no change"}`);
  }
}

export async function stamp(root: string, cards: string[]): Promise<void> {
  const config = await loadConfig(root);
  const all = await readCards(root, config.cards?.dir ?? "map");
  const store = fileStore(root, config.out);
  const approved = await Promise.all(LAYER_IDS.map((id) => store.read(id, "approved")));
  const graphs = approved.filter((g) => g !== null);
  for (const c of all.filter((c) => cards.some((p) => resolve(root, p) === resolve(root, c.path))))
    await restamp(root, c, graphs);
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
    .option("-C, --root <dir>", "repo root", ".");
  const root = () => resolve(p.opts<{ root: string }>().root);
  p.command("gen")
    .argument("[layers...]")
    .description("write the current map and its pages")
    .action(async (args: string[]) => gen({ root: root(), layers: layerArgs(args) }));
  p.command("check")
    .argument("[layers...]")
    .description("gen, then fail on drift from the approved map")
    .action(async (args: string[]) => {
      process.exitCode = await check({ root: root(), layers: layerArgs(args) });
    });
  p.command("approve")
    .argument("[layers...]")
    .description("make the current map the approved one; commit the result")
    .action(async (args: string[]) => approve({ root: root(), layers: layerArgs(args) }));
  p.command("stamp")
    .argument("<cards...>")
    .description("mark cards read against the approved map")
    .action(async (cards: string[]) => stamp(root(), cards));
  return p;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === self) await program().parseAsync();
