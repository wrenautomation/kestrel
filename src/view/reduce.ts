/**
 * Transitive reduction of one level's lines: a→c is implied when a reaches c through other boxes.
 * Done on the strongly connected parts, so a cycle never drops the lines that hold it up.
 * The page lays out and draws the rest; an implied line shows only for the selected box.
 */
export function implied(edges: readonly { from: string; to: string }[]): Set<number> {
  const ids = [...new Set(edges.flatMap((e) => [e.from, e.to]))];
  const out = new Map<string, string[]>(ids.map((v) => [v, []]));
  for (const e of edges) out.get(e.from)?.push(e.to);

  // Tarjan, iterative: comp[v] = its part.
  const comp = new Map<string, number>();
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  let next = 0;
  let parts = 0;
  for (const s of ids) {
    if (index.has(s)) continue;
    const work: [string, number][] = [[s, 0]];
    index.set(s, next);
    low.set(s, next++);
    stack.push(s);
    on.add(s);
    while (work.length) {
      const top = work[work.length - 1] as [string, number];
      const [v, i] = top;
      const ws = out.get(v) ?? [];
      if (i < ws.length) {
        top[1]++;
        const w = ws[i] as string;
        if (!index.has(w)) {
          index.set(w, next);
          low.set(w, next++);
          stack.push(w);
          on.add(w);
          work.push([w, 0]);
        } else if (on.has(w)) low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
        continue;
      }
      work.pop();
      const up = work[work.length - 1];
      if (up) low.set(up[0], Math.min(low.get(up[0]) ?? 0, low.get(v) ?? 0));
      if (low.get(v) === index.get(v)) {
        let w: string | undefined;
        do {
          w = stack.pop() as string;
          on.delete(w);
          comp.set(w, parts);
        } while (w !== v);
        parts++;
      }
    }
  }

  // Lines between parts; a part pair is implied when a longer path joins them.
  const dag = new Map<number, Set<number>>();
  for (const e of edges) {
    const a = comp.get(e.from) as number;
    const b = comp.get(e.to) as number;
    if (a !== b) (dag.get(a) ?? dag.set(a, new Set()).get(a))?.add(b);
  }
  const long = (a: number, b: number) => {
    const seen = new Set<number>();
    const q = [...(dag.get(a) ?? [])].filter((x) => x !== b);
    while (q.length) {
      const x = q.pop() as number;
      if (x === b) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      for (const y of dag.get(x) ?? []) q.push(y);
    }
    return false;
  };
  const memo = new Map<string, boolean>();
  const drop = new Set<number>();
  edges.forEach((e, i) => {
    const a = comp.get(e.from) as number;
    const b = comp.get(e.to) as number;
    if (a === b) return;
    const k = `${a}>${b}`;
    if (!memo.has(k)) memo.set(k, long(a, b));
    if (memo.get(k)) drop.add(i);
  });
  return drop;
}
