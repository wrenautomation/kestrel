import { useMemo, useState } from "react";
import type { ViewData } from "../../src/view/types";
import { Dialog } from "./Dialog";

interface Hit {
  label: string;
  kind: string;
  where: string;
  box: string;
  item?: string;
}

interface Props {
  data: ViewData;
  onPick(box: string, item?: string): void;
  onClose(): void;
}

/** Paths read without the npm scope every package shares. */
const short = (id: string) => id.replace(/^@[^/]+\//, "");

/** Boxes, exports and routes by name: exact first, then prefix, then anywhere. */
export function Search({ data, onPick, onClose }: Props) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const all = useMemo<Hit[]>(() => {
    const out: Hit[] = Object.values(data.nodes).map((n) => ({
      label: n.label,
      kind: n.role,
      where: short(n.id),
      box: n.id,
    }));
    for (const [box, d] of Object.entries(data.details)) {
      if (data.nodes[box]?.role !== "file") continue;
      for (const e of d.exports)
        out.push({ label: e.name, kind: e.kind, where: short(box), box, item: e.id });
      for (const s of d.services) {
        out.push({
          label: s.name,
          kind: s.kind === "service" ? "service" : `${s.kind} service`,
          where: short(box),
          box,
          item: s.id,
        });
        for (const r of s.routes)
          out.push({
            label: `${s.name}/${r.name}`,
            kind: "route",
            where: short(box),
            box,
            item: r.id,
          });
      }
    }
    return out;
  }, [data]);
  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    const rank = (h: Hit) => {
      const l = h.label.toLowerCase();
      if (l === t) return 0;
      if (l.startsWith(t)) return 1;
      if (l.includes(t)) return 2;
      return h.where.toLowerCase().includes(t) ? 3 : 9;
    };
    return all
      .map((h) => ({ h, r: rank(h) }))
      .filter((x) => x.r < 9)
      .sort((a, b) => a.r - b.r || a.h.label.length - b.h.label.length)
      .slice(0, 60)
      .map((x) => x.h);
  }, [q, all]);
  const pick = (h: Hit | undefined) => h && onPick(h.box, h.item);
  return (
    <Dialog className="search" onClose={onClose}>
      <div className="inner">
        <input
          value={q}
          placeholder="Package, file, export or route"
          onChange={(e) => {
            setQ(e.target.value);
            setAt(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setAt((a) => Math.min(a + 1, hits.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setAt((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") pick(hits[at]);
          }}
        />
        <ul>
          {hits.map((h, i) => (
            <li key={`${h.where}\0${h.item ?? ""}\0${h.label}`}>
              <button
                type="button"
                className={i === at ? "now" : ""}
                onMouseEnter={() => setAt(i)}
                onClick={() => pick(h)}
              >
                <b>{h.label}</b> <span className="meta">{h.kind}</span>
                <span className="where">{h.where}</span>
              </button>
            </li>
          ))}
        </ul>
        {q && !hits.length && <p className="meta pad">No match.</p>}
      </div>
    </Dialog>
  );
}
