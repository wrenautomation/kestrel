/**
 * `kestrel watch`: one process keeps the TS project warm; each save re-reads only the changed
 * files (workspace.refresh), then gen runs on the cache (cache.ts) and skips what did not move.
 * Runs never overlap: saves during a run fold into one more run.
 */
import { watch as fsWatch } from "node:fs";
import { relative } from "node:path";
import { refresh } from "./layers/workspace.js";

export interface WatchOptions {
  root: string;
  /** Repo-relative dirs a change in which never counts (the map's own output, builds). */
  ignore: readonly string[];
  run(changed: readonly string[]): Promise<void>;
  /** Quiet time after the last save before a run, ms. */
  settle?: number;
}

const SKIP = /(^|\/)(node_modules|\.git|dist|build|coverage|storybook-static|\.turbo)(\/|$)/;

export function watch(opts: WatchOptions): () => void {
  const settle = opts.settle ?? 250;
  let queued = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  const flush = async () => {
    if (running || !queued.size) return;
    running = true;
    const changed = [...queued];
    queued = new Set();
    try {
      refresh(opts.root, changed);
      await opts.run(changed);
    } catch (e) {
      console.error(`watch: ${(e as Error).message}`);
    } finally {
      running = false;
      if (queued.size) void flush();
    }
  };
  const w = fsWatch(opts.root, { recursive: true }, (_, name) => {
    if (!name) return;
    const rel = relative(opts.root, `${opts.root}/${name}`);
    if (SKIP.test(rel) || opts.ignore.some((d) => rel.startsWith(d))) return;
    queued.add(rel);
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), settle);
  });
  return () => {
    clearTimeout(timer);
    w.close();
  };
}
