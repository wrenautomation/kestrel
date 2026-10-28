import { useCallback, useEffect, useState } from "react";
import type { TreeNode, ViewData } from "../../src/view/types";
import { Canvas } from "./Canvas";
import { Detail } from "./Detail";
import { Note } from "./Note";
import { Search } from "./Search";

/** `#f=<focus>&s=<selected>`: every view is a link, and a note carries it. */
function readHash(): { f?: string; s?: string } {
  const p = new URLSearchParams(location.hash.slice(1));
  return {
    ...(p.get("f") ? { f: p.get("f") as string } : {}),
    ...(p.get("s") ? { s: p.get("s") as string } : {}),
  };
}

export function App() {
  const [data, setData] = useState<ViewData>();
  const [error, setError] = useState<string>();
  const [focus, setFocus] = useState<string>();
  const [sel, setSel] = useState<string>();
  const [mark, setMark] = useState<string>();
  const [panel, setPanel] = useState<"search" | "note">();

  useEffect(() => {
    fetch("./data.json")
      .then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t)))))
      .then((d: ViewData) => {
        setData(d);
        const h = readHash();
        const root = Object.values(d.nodes).find((n) => !n.parent)?.id;
        const s = h.s ? d.nodes[h.s] : undefined;
        // A stale link: keep the box if it still exists, else start at the top.
        setFocus(h.f && d.levels[h.f] ? h.f : (s?.parent ?? root));
        setSel(s?.id);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  // A pasted or edited link moves the view; our own replaceState fires no hashchange.
  useEffect(() => {
    if (!data) return;
    const on = () => {
      const h = readHash();
      const s = h.s ? data.nodes[h.s] : undefined;
      if (h.f && data.levels[h.f]) setFocus(h.f);
      else if (s?.parent) setFocus(s.parent);
      setSel(s?.id);
      setMark(undefined);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, [data]);

  useEffect(() => {
    if (!focus) return;
    const p = new URLSearchParams({ f: focus, ...(sel ? { s: sel } : {}) });
    history.replaceState(null, "", `#${p}`);
  }, [focus, sel]);

  /** Show a box: open its parent's level and select it. */
  const go = useCallback(
    (id: string, item?: string) => {
      const n = data?.nodes[id];
      if (!n) return;
      setFocus(n.parent ?? n.id);
      setSel(n.parent ? n.id : undefined);
      setMark(item);
    },
    [data],
  );
  const open = useCallback(
    (id: string) => {
      if (!data?.levels[id]) return;
      setFocus(id);
      setSel(undefined);
      setMark(undefined);
    },
    [data],
  );
  const up = useCallback(() => {
    const f = focus ? data?.nodes[focus] : undefined;
    if (f?.parent) {
      setFocus(f.parent);
      setSel(f.id);
    }
  }, [data, focus]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (panel) return;
      if (e.key === "/") {
        e.preventDefault();
        setPanel("search");
      } else if (e.key === "n") {
        e.preventDefault();
        setPanel("note");
      } else if (e.key === "Enter" && sel) open(sel);
      else if (e.key === "Escape" || e.key === "Backspace" || e.key === "u") up();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [panel, sel, open, up]);

  if (error) return <div className="msg">kestrel view: {error}</div>;
  if (!data || !focus) return <div className="msg">Loading the map…</div>;

  const trail: TreeNode[] = [];
  for (
    let n: TreeNode | undefined = data.nodes[focus];
    n;
    n = n.parent ? data.nodes[n.parent] : undefined
  )
    trail.unshift(n);
  const shown = sel ?? focus;
  const c = data.counts;

  return (
    <div className="app">
      <header className="bar">
        <span className="brand">kestrel</span>
        <nav className="trail" aria-label="Path">
          {trail.map((n, i) => (
            <button
              type="button"
              key={n.id}
              className={i === trail.length - 1 ? "crumb now" : "crumb"}
              onClick={() => open(n.id)}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <span className="counts">
          {c.files} files · {c.exports} exports · {c.services} services · {c.routes} routes
        </span>
        {data.approved ? (
          <span className={c.drift ? "chip warn" : "chip good"}>
            {c.drift ? `${c.drift} changed since approve` : "matches approved"}
          </span>
        ) : (
          <span className="chip">nothing approved yet</span>
        )}
        <button type="button" className="key" onClick={() => setPanel("search")}>
          <kbd>/</kbd> search
        </button>
        <button type="button" className="key" onClick={() => setPanel("note")}>
          <kbd>n</kbd> note
        </button>
      </header>
      <main className="body">
        <Canvas data={data} focus={focus} sel={sel} onSelect={setSel} onOpen={open} />
        <Detail data={data} id={shown} mark={mark} onGo={go} onOpen={open} />
      </main>
      {panel === "search" && (
        <Search
          data={data}
          onPick={(box, item) => {
            setPanel(undefined);
            go(box, item);
          }}
          onClose={() => setPanel(undefined)}
        />
      )}
      {panel === "note" && <Note data={data} about={shown} onClose={() => setPanel(undefined)} />}
    </div>
  );
}
