#!/usr/bin/env node
/**
 * kestrel gen [layer...]      extract, write current + pages
 * kestrel check [layer...]    gen, then fail on drift vs approved, or a card issue
 * kestrel approve [layer...]  current → approved for the whole map (commit it: that is the approval)
 * kestrel stamp <card...>     mark cards read against the approved graph
 */
import type { Command } from "commander";
import { checkCards, readCards, restamp } from "./cards.js";
import { type LayerId, loadConfig } from "./config.js";
import { diff, formatChanges } from "./diff.js";
import { LAYERS } from "./layers/index.js";
import { fileStore } from "./store.js";
import { todo } from "./todo.js";

export interface RunOptions {
  root: string;
  layers: LayerId[];
}

export async function gen(opts: RunOptions): Promise<void> {
  return todo(opts, loadConfig, LAYERS, fileStore);
}

/** Exit code: 0 clean, 1 drift or card issues. */
export async function check(opts: RunOptions): Promise<number> {
  return todo(opts, diff, formatChanges, readCards, checkCards);
}

export async function approve(opts: RunOptions): Promise<void> {
  return todo(opts, fileStore);
}

export async function stamp(root: string, cards: string[]): Promise<void> {
  return todo(root, cards, readCards, restamp);
}

export function program(): Command {
  return todo();
}
