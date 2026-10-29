import { useEffect, useRef, useState } from "react";
import type { SliceCall, SliceItem, ViewData } from "../../src/view/types";

/**
 * A screen and what is behind it, in columns: the screen, the routes it calls, the tables they
 * touch, what they reach outside. Hover a call: the other columns keep what it reaches. Hover a
 * table or an outside item: the calls keep the ones that reach it. Shared items fold to the foot.
 * With a Storybook and a page story, the screen runs live in a frame; the story's fake server
 * posts each call's key (`{kestrel: "call", key}`), and the calls that ran are marked. Alt+click
 * in it posts the parts under the click (`{kestrel: "source", chain}`, innermost first): they
 * list under the frame, the screen's own file marked, each a link to its file. Flow: the same
 * posts in order, repeats kept, one row per call with what its route reaches, in lanes.
 */
interface Step {
  key: string;
  at: number;
}

interface Props {
  data: ViewData;
  id: string;
  onGo: (box: string, item?: string) => void;
  onMap: () => void;
}

const KIND: Record<SliceItem["kind"], string> = {
  reads: "reads",
  writes: "writes",
  system: "system",
  npm: "package",
  host: "host",
};

/** A path that breaks after a slash, never inside a name. */
function Wrap({ path }: { path: string }) {
  const parts = path.split("/");
  return (
    <>
      {parts.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string
        <span key={i}>
          {p}
          {i < parts.length - 1 && (
            <>
              /<wbr />
            </>
          )}
        </span>
      ))}
    </>
  );
}

const groups = <T,>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
};

/** Call literals no route matches. */
function Lost({ title, list }: { title: string; list: string[] | undefined }) {
  if (!list?.length) return null;
  return (
    <>
      <h3>{title}</h3>
      <ul>
        {list.map((x) => (
          <li key={x}>
            <code>{x}</code>
          </li>
        ))}
      </ul>
    </>
  );
}

function Column<T extends { id: string; shared?: true }>({
  title,
  list,
  row,
  note,
  group,
}: {
  title: string;
  list: T[];
  row: (x: T) => React.ReactNode;
  note?: string | undefined;
  /** Rows under a label each: a call's file. */
  group?: (x: T) => string;
}) {
  const [open, setOpen] = useState(false);
  const own = list.filter((x) => !x.shared);
  const shared = list.filter((x) => x.shared);
  return (
    <section className="col">
      <h3>
        {title} <span className="n">{own.length}</span>
      </h3>
      {!list.length && <p className="none">{note ?? "None."}</p>}
      {group ? (
        [...groups(own, group)].map(([label, xs]) => (
          <div key={label} className="group">
            {label && (
              <p className="lead">
                <Wrap path={label} />
              </p>
            )}
            <ul>{xs.map(row)}</ul>
          </div>
        ))
      ) : (
        <ul>{own.map(row)}</ul>
      )}
      {shared.length > 0 && (
        <>
          <button type="button" className="fold" onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Show"} {shared.length} shared by most screens
          </button>
          {open && <ul className="shared">{shared.map(row)}</ul>}
        </>
      )}
    </section>
  );
}

/** Desktop width the frame draws at, scaled down to its column. */
const DRAW = 1100;

/** `pages-learn--sources-pick-two-fast` → `Sources pick two fast`. */
const storyName = (id: string) => {
  const s = (id.split("--")[1] ?? id).replace(/-/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** `<path>:<line>:<col>:<tag>`, innermost first → one per file run, outermost first. */
export function sourceChain(
  chain: readonly string[],
): { path: string; line: string; tag: string }[] {
  const out: { path: string; line: string; tag: string }[] = [];
  for (const at of chain) {
    const m = /^(.*?):(\d+):\d+:([^:/]*)$/.exec(at);
    const it = m ? { path: m[1] as string, line: m[2] as string, tag: m[3] as string } : undefined;
    if (it && out.at(-1)?.path !== it.path) out.push(it);
  }
  return out.reverse();
}

/** The file box of a repo path (or one under `root`), by its package's dir. */
export function boxOfPath(data: ViewData, path: string): string | undefined {
  const rel = path.startsWith(`${data.root}/`) ? path.slice(data.root.length + 1) : path;
  const hit = data.dirs?.find(([, d]) => d && rel.startsWith(d));
  const box = hit && `${hit[0]}/${rel.slice(hit[1].length)}`;
  return box && data.nodes[box] ? box : undefined;
}

function Live({
  base,
  ids,
  onCall,
  onSource,
}: {
  base: string;
  ids: string[];
  onCall: (key: string) => void;
  /** Alt+click in the frame: `<path>:<line>:<col>:<tag>` per tagged part, innermost first. */
  onSource: (chain: string[]) => void;
}) {
  const [at, setAt] = useState(ids[0] as string);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!ids.includes(at)) setAt(ids[0] as string);
  }, [ids, at]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(
      ([e]) => e && setSize({ w: e.contentRect.width, h: e.contentRect.height }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const origin = new URL(base).origin;
    const on = (e: MessageEvent) => {
      if (e.origin !== origin) return;
      if (e.data?.kestrel === "call" && typeof e.data.key === "string") onCall(e.data.key);
      if (e.data?.kestrel !== "source") return;
      const chain = Array.isArray(e.data.chain) ? e.data.chain : [e.data.at];
      const ok = chain.filter((x: unknown): x is string => typeof x === "string");
      if (ok.length) onSource(ok);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [base, onCall, onSource]);
  const scale = size.w ? size.w / DRAW : 1;
  const src = `${base.replace(/\/$/, "")}/iframe.html?id=${encodeURIComponent(at)}&viewMode=story&kestrel`;
  return (
    <>
      {ids.length > 1 && (
        <div className="tabs">
          {ids.map((id) => (
            <button key={id} type="button" aria-pressed={id === at} onClick={() => setAt(id)}>
              {storyName(id)}
            </button>
          ))}
        </div>
      )}
      <div className="frame" ref={box}>
        {size.w > 0 && (
          <iframe
            key={src}
            title={storyName(at)}
            src={src}
            style={{ width: DRAW, height: size.h / scale, transform: `scale(${scale})` }}
          />
        )}
      </div>
      <p className="meta">
        Fake data.{" "}
        <a
          href={`${base.replace(/\/$/, "")}/?path=/story/${encodeURIComponent(at)}`}
          target="_blank"
          rel="noreferrer"
        >
          Open in Storybook
        </a>
        . <kbd>Alt</kbd>+click a part: the files under it. Blank: run <code>storybook</code> in the
        repo.
      </p>
    </>
  );
}

export function Slice({ data, id, onGo, onMap }: Props) {
  const n = data.nodes[id];
  const d = data.details[id];
  const sl = d?.slice;
  // a call id, or an item id: what the hover keeps lit
  const [hot, setHot] = useState<{ call?: string; item?: SliceItem }>({});
  // call keys the live story sent, and the parts under the last Alt+click; reset per screen
  const [log, setLog] = useState<readonly Step[]>([]);
  const [under, setUnder] = useState<string[]>([]);
  const [was, setWas] = useState(id);
  if (was !== id) {
    setWas(id);
    setLog([]);
    setUnder([]);
  }
  const onCall = useRef((key: string) =>
    setLog((l) => [...l, { key, at: performance.now() }]),
  ).current;
  const ran = new Set(log.map((s) => s.key));
  const onSource = useRef((chain: string[]) => setUnder(chain)).current;
  if (!n) return null;
  const live = data.storybook && sl?.stories?.length ? sl.stories : undefined;
  const known = new Set((sl?.calls ?? []).flatMap((c) => (c.path ? [c.path] : [])));
  for (const k of [...(sl?.missing ?? []), ...(sl?.host ?? [])]) known.add(k);
  const extra = [...ran].filter((k) => !known.has(k)).sort();
  const a = d?.attrs ?? {};
  const template = a.template !== "hand";
  const file = d?.code?.[0];
  const stories = (file?.box && data.details[file.box]?.stories) || [];
  const lit = (it: SliceItem) => !hot.call || it.via.includes(hot.call);
  const litCall = (c: SliceCall) =>
    hot.item ? hot.item.via.includes(c.id) : !hot.call || hot.call === c.id;
  const cls = (on: boolean, shared?: true) =>
    [on ? "" : "dim", shared ? "is-shared" : ""].filter(Boolean).join(" ");

  const item = (it: SliceItem) => (
    <li
      key={`${it.kind}:${it.id}`}
      className={cls(lit(it), it.shared)}
      onMouseEnter={() => setHot({ item: it })}
      onMouseLeave={() => setHot({})}
    >
      <button type="button" disabled={!it.box} onClick={() => it.box && onGo(it.box)}>
        {it.label}
      </button>
      <span className={`tag k-${it.kind}`}>{KIND[it.kind]}</span>
      {it.via.length > 1 && <span className="meta">{it.via.length} calls</span>}
    </li>
  );

  return (
    <div className={live ? "slice live" : "slice"}>
      <header className="slice-bar">
        <h2>{n.label}</h2>
        <span className="meta">{n.sub}</span>
        <button type="button" className="key" onClick={onMap}>
          <kbd>m</kbd> map
        </button>
      </header>
      <div className="cols">
        <section className="col screen">
          {live && data.storybook && (
            <Live base={data.storybook} ids={live} onCall={onCall} onSource={onSource} />
          )}
          <h3>Screen</h3>
          <dl className="facts">
            <dt>Template</dt>
            <dd>{String(a.template)}</dd>
            {typeof a.record === "string" && (
              <>
                <dt>Record</dt>
                <dd>{a.record}</dd>
              </>
            )}
            {file && (
              <>
                <dt>Drawn in</dt>
                <dd>
                  <button
                    type="button"
                    className="link"
                    disabled={!file.box}
                    onClick={() => file.box && onGo(file.box)}
                  >
                    <Wrap path={file.path} />
                  </button>
                </dd>
              </>
            )}
          </dl>
          {template && (
            <p className="none">Drawn by the template: its calls are the template's own.</p>
          )}
          {!live && (
            <h3>
              Stories <span className="n">{stories.length}</span>
            </h3>
          )}
          {live ? null : stories.length ? (
            <ul>
              {stories.map((s) => (
                <li key={s.id}>
                  <button type="button" disabled={!s.box} onClick={() => s.box && onGo(s.box)}>
                    {s.title}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="none">No story shows this screen alone.</p>
          )}
          {under.length > 0 && (
            <>
              <h3>Under the click</h3>
              <ol className="chain">
                {sourceChain(under).map((p) => {
                  const box = boxOfPath(data, p.path);
                  return (
                    <li key={p.path} className={p.path === file?.path ? "own" : undefined}>
                      <button type="button" disabled={!box} onClick={() => box && onGo(box)}>
                        <Wrap path={p.path} />
                      </button>
                      <span className="meta">
                        {p.tag} line {p.line}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
          <Lost title="No such route" list={sl?.missing} />
          <Lost title="The host answers" list={sl?.host} />
          <Lost title="Ran, not in this slice" list={extra} />
        </section>
        <Column
          title="Calls"
          list={sl?.calls ?? []}
          note={template ? "The template's calls are not read." : "No call found."}
          group={(c) => c.at.join(", ")}
          row={(c) => (
            <li
              key={c.id}
              className={cls(litCall(c), c.shared)}
              onMouseEnter={() => setHot({ call: c.id })}
              onMouseLeave={() => setHot({})}
            >
              <button type="button" disabled={!c.box} onClick={() => c.box && onGo(c.box, c.id)}>
                {c.name}
              </button>
              {c.path && ran.has(c.path) && <span className="tag k-ran">ran</span>}
            </li>
          )}
        />
        <Column
          title="Tables"
          list={sl?.tables ?? []}
          row={item}
          note={a.record ? "No table: its rows come from code or from outside." : undefined}
        />
        <Column title="Outside" list={sl?.outside ?? []} row={item} />
      </div>
      {live && (
        <Flow
          log={log}
          calls={sl?.calls ?? []}
          items={[...(sl?.tables ?? []), ...(sl?.outside ?? [])]}
          onGo={onGo}
          onClear={() => setLog([])}
        />
      )}
    </div>
  );
}

/** The live story's calls in order: time from the first, the route, then what it reaches. */
function Flow({
  log,
  calls,
  items,
  onGo,
  onClear,
}: {
  log: readonly Step[];
  calls: readonly SliceCall[];
  items: readonly SliceItem[];
  onGo: Props["onGo"];
  onClear: () => void;
}) {
  const byPath = new Map(calls.flatMap((c) => (c.path ? [[c.path, c] as const] : [])));
  const t0 = log[0]?.at ?? 0;
  // the same call again at once (a list's rows each asking) folds into one row
  const rows: (Step & { n: number })[] = [];
  for (const s of log) {
    const last = rows.at(-1);
    if (last?.key === s.key) last.n++;
    else rows.push({ ...s, n: 1 });
  }
  const lane = (c: SliceCall | undefined, keep: (it: SliceItem) => boolean) =>
    c ? items.filter((it) => it.via.includes(c.id) && keep(it)) : [];
  const cell = (list: SliceItem[]) => (
    <td>
      {list.map((it) => (
        <button type="button" key={it.id} disabled={!it.box} onClick={() => it.box && onGo(it.box)}>
          {it.label}
        </button>
      ))}
    </td>
  );
  return (
    <section className="flow">
      <h3>
        Flow <span className="n">{log.length}</span>
        <button type="button" className="key" onClick={onClear} disabled={!log.length}>
          clear
        </button>
      </h3>
      {log.length ? (
        <div className="flow-scroll">
          <table>
            <thead>
              <tr>
                <th>ms</th>
                <th>Call</th>
                <th>Writes</th>
                <th>Reads</th>
                <th>Outside</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s, i) => {
                const c = byPath.get(s.key);
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a log row is its place in the log
                  <tr key={i} className={c ? undefined : "lost"}>
                    <td className="ms">{Math.round(s.at - t0)}</td>
                    <td>
                      {c ? (
                        <button
                          type="button"
                          disabled={!c.box}
                          onClick={() => c.box && onGo(c.box, c.id)}
                        >
                          {c.name}
                        </button>
                      ) : (
                        <code>{s.key}</code>
                      )}
                      {s.n > 1 && <span className="meta"> ×{s.n}</span>}
                    </td>
                    {cell(lane(c, (it) => it.kind === "writes"))}
                    {cell(lane(c, (it) => it.kind === "reads"))}
                    {cell(lane(c, (it) => it.kind !== "reads" && it.kind !== "writes"))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="none">Use the screen: each call it makes adds a row here.</p>
      )}
    </section>
  );
}
