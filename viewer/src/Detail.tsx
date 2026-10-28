import { useEffect, useRef } from "react";
import type { Item, Link, Service, ViewData } from "../../src/view/types";

interface Props {
  data: ViewData;
  id: string;
  /** An export or route to scroll to and mark. */
  mark: string | undefined;
  onGo(id: string, item?: string): void;
  onOpen(id: string): void;
}

const DRIFT = {
  add: "new since approve",
  change: "changed since approve",
  inside: "changes inside",
};

/** The package part of a file id: `@scope/name` or `name`. */
const pkgPart = (id: string) => /^(@[^/]+\/[^/]+|[^@/][^/]*)\//.exec(id)?.[1];

function Links({
  title,
  list,
  data,
  from,
  onGo,
}: {
  title: string;
  list: Link[];
  data: ViewData;
  /** The box shown: a file in its own package reads without the package name. */
  from: string;
  onGo: Props["onGo"];
}) {
  const own = pkgPart(from);
  if (!list.length) return null;
  return (
    <section>
      <h3>
        {title} <span className="n">{list.length}</span>
      </h3>
      <ul className="links">
        {list.map((l) => (
          <li key={l.id}>
            <button type="button" onClick={() => onGo(l.id)}>
              {data.nodes[l.id]?.role !== "file"
                ? l.id
                : pkgPart(l.id) === own
                  ? l.id.slice((own?.length ?? -1) + 1)
                  : l.id.replace(/^@[^/]+\//, "")}
            </button>
            <span className="meta">
              {l.n}
              {l.type ? " · types" : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Row({ it, mark }: { it: Item; mark: string | undefined }) {
  return (
    <li
      className={[it.id === mark ? "marked" : "", it.drift ? `drift-${it.drift}` : ""].join(" ")}
      data-id={it.id}
    >
      <div className="name">
        <b>{it.name}</b> <span className="meta">{it.kind}</span>
        {it.inferred && <span className="tag warn">inferred</span>}
        {it.drift && <span className="tag">{it.drift === "add" ? "new" : "changed"}</span>}
      </div>
      {it.sig && <code>{it.sig}</code>}
    </li>
  );
}

function Services({
  list,
  mark,
  onGo,
}: {
  list: Service[];
  mark: string | undefined;
  onGo: Props["onGo"];
}) {
  if (!list.length) return null;
  // A folder lists its services in one line each; the routes sit in the file's own panel.
  const brief = list.every((s) => !s.routes.length);
  return (
    <section>
      <h3>
        Services <span className="n">{list.length}</span>
      </h3>
      {brief ? (
        <ul className="links">
          {list.map((s) => (
            <li key={s.id} className={s.drift ? `drift-${s.drift}` : ""}>
              <button type="button" onClick={() => onGo(s.box, s.id)}>
                {s.name}
              </button>
              <span className="meta">
                {s.routeCount} route{s.routeCount === 1 ? "" : "s"}
                {s.drift ? (s.drift === "add" ? " · new" : " · changed") : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        list.map((s) => (
          <div key={s.id} className="svc" data-id={s.id}>
            <div className="name">
              <b>{s.name}</b> <span className="meta">{s.kind}</span>
              {s.drift && <span className="tag">{s.drift === "add" ? "new" : "changed"}</span>}
            </div>
            <ul className="items">
              {s.routes.map((r) => (
                <Row key={r.id} it={r} mark={mark} />
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

export function Detail({ data, id, mark, onGo, onOpen }: Props) {
  const n = data.nodes[id];
  const d = data.details[id];
  const ref = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new box scrolls back to the top
  useEffect(() => {
    if (!mark) {
      ref.current?.scrollTo({ top: 0 });
      return;
    }
    ref.current
      ?.querySelector(`[data-id="${CSS.escape(mark)}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [id, mark]);
  if (!n) return <aside className="detail" />;
  const npm = d?.attrs?.npm;
  return (
    <aside className="detail" ref={ref}>
      <header>
        <span className={`dot role-${n.role}`} />
        <h2>{n.label}</h2>
        <span className="meta">{n.role}</span>
      </header>
      <p className="path">{n.id}</p>
      {n.drift && <p className={`drift drift-${n.drift}`}>{DRIFT[n.drift]}</p>}
      <dl className="facts">
        {n.kids.length > 0 && (
          <>
            <dt>Files</dt>
            <dd>{n.files}</dd>
          </>
        )}
        {(d?.exportCount ?? 0) > 0 && (
          <>
            <dt>Exports</dt>
            <dd>
              {d?.exportCount}
              {d?.inferred ? ` (${d.inferred} inferred)` : ""}
            </dd>
          </>
        )}
        {(d?.services.length ?? 0) > 0 && (
          <>
            <dt>Routes</dt>
            <dd>{d?.services.reduce((a, s) => a + s.routeCount, 0)}</dd>
          </>
        )}
      </dl>
      {n.kids.length > 0 && (
        <button type="button" className="open" onClick={() => onOpen(n.id)}>
          Open <kbd>Enter</kbd>
        </button>
      )}
      {n.removed?.length ? (
        <section>
          <h3>
            Gone since approve <span className="n">{n.removed.length}</span>
          </h3>
          <ul className="plain">
            {n.removed.map((r) => (
              <li key={r}>
                <code>{r}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {d?.cards.map((c) => (
        <section className="card" key={c.path}>
          <h3>
            {c.type === "object" || c.type === "process" ? "Why" : c.type}{" "}
            <span className="meta">{c.path}</span>
          </h3>
          <p>{c.why}</p>
          {c.stale && <p className="tag warn">stale: the code changed since the card was read</p>}
        </section>
      ))}
      {d && (
        <>
          <Links title="Uses" list={d.uses} data={data} from={n.id} onGo={onGo} />
          <Links title="Used by" list={d.usedBy} data={data} from={n.id} onGo={onGo} />
          {Array.isArray(npm) && npm.length > 0 && (
            <section>
              <h3>
                Outside packages <span className="n">{npm.length}</span>
              </h3>
              <p className="npm">{[...npm].sort().join(", ")}</p>
            </section>
          )}
          <Services list={d.services} mark={mark} onGo={onGo} />
          {n.role === "file" && d.exports.length > 0 && (
            <section>
              <h3>
                Exports <span className="n">{d.exports.length}</span>
              </h3>
              <ul className="items">
                {d.exports.map((e) => (
                  <Row key={e.id} it={e} mark={mark} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </aside>
  );
}
