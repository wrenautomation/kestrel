import { useState } from "react";
import type { SliceCall, SliceItem, ViewData } from "../../src/view/types";

/**
 * A screen and what is behind it, in columns: the screen, the routes it calls, the tables they
 * touch, what they reach outside. Hover a call: the other columns keep what it reaches. Hover a
 * table or an outside item: the calls keep the ones that reach it. Shared items fold to the foot.
 */
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
  note?: string;
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

export function Slice({ data, id, onGo, onMap }: Props) {
  const n = data.nodes[id];
  const d = data.details[id];
  const sl = d?.slice;
  // a call id, or an item id: what the hover keeps lit
  const [hot, setHot] = useState<{ call?: string; item?: SliceItem }>({});
  if (!n) return null;
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
    <div className="slice">
      <header className="slice-bar">
        <h2>{n.label}</h2>
        <span className="meta">{n.sub}</span>
        <button type="button" className="key" onClick={onMap}>
          <kbd>m</kbd> map
        </button>
      </header>
      <div className="cols">
        <section className="col screen">
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
          <h3>
            Stories <span className="n">{stories.length}</span>
          </h3>
          {stories.length ? (
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
          <Lost title="No such route" list={sl?.missing} />
          <Lost title="The host answers" list={sl?.host} />
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
            </li>
          )}
        />
        <Column title="Tables" list={sl?.tables ?? []} row={item} />
        <Column title="Outside" list={sl?.outside ?? []} row={item} />
      </div>
    </div>
  );
}
