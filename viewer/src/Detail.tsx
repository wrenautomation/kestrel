import { useEffect, useRef } from "react";
import type {
  Detail as DetailData,
  Item,
  Link,
  Path,
  Seam,
  Service,
  ViewData,
} from "../../src/view/types";

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

/** A system box by name; a part reads with its system: `wren / Lambda worker`. */
const sysName = (data: ViewData, id: string) => {
  const n = data.nodes[id];
  const up = n?.role === "part" && n.parent ? data.nodes[n.parent] : undefined;
  return up ? `${up.label} / ${n?.label}` : (n?.label ?? id);
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
              {data.nodes[l.id]?.role === "table"
                ? l.id.slice("table:".length)
                : data.nodes[l.id]?.role === "system" || data.nodes[l.id]?.role === "part"
                  ? sysName(data, l.id)
                  : data.nodes[l.id]?.role !== "file"
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

/** Code paths: a button when the map has the box, plain text when it is outside the repo. */
function Paths({ list, onGo }: { list: Path[]; onGo: Props["onGo"] }) {
  return (
    <div className="paths">
      {list.map((p) =>
        p.box ? (
          <button type="button" key={p.path} onClick={() => onGo(p.box as string)}>
            <code>{p.path}</code>
          </button>
        ) : (
          <code key={p.path}>{p.path}</code>
        ),
      )}
    </div>
  );
}

/** A system's own relations (not those of its parts), out then in, each with what it is for and the code at both ends. */
function Seams({ list, data, onGo }: { list: Seam[]; data: ViewData; onGo: Props["onGo"] }) {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => Number(b.out) - Number(a.out));
  return (
    <section>
      <h3>
        Relations <span className="n">{list.length}</span>
      </h3>
      <ul className="rels">
        {sorted.map((s) => (
          <li key={`${s.out}${s.kind}${s.id}`}>
            <div className="name">
              <span className="meta">{s.out ? "to" : "from"}</span>{" "}
              <button type="button" onClick={() => onGo(s.id)}>
                {sysName(data, s.id)}
              </button>{" "}
              <span className="meta">{s.kind}</span>
            </div>
            {s.titles.length > 0 && <p>{s.titles.join("; ")}</p>}
            {s.here.length > 0 && (
              <div className="ends">
                <span className="meta">{s.out ? "here" : "there"}</span>
                <Paths list={s.here} onGo={onGo} />
              </div>
            )}
            {s.there.length > 0 && (
              <div className="ends">
                <span className="meta">{s.out ? "there" : "here"}</span>
                <Paths list={s.there} onGo={onGo} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A table's columns, keys and indexes, as Postgres has them. */
function Table({
  attrs,
  indexes,
  mark,
}: {
  attrs: DetailData["attrs"];
  indexes: Item[];
  mark: string | undefined;
}) {
  const list = (k: string) => {
    const v = attrs?.[k];
    return Array.isArray(v) ? (v as readonly string[]) : [];
  };
  const part = (title: string, rows: readonly string[]) =>
    rows.length > 0 && (
      <section>
        <h3>
          {title} <span className="n">{rows.length}</span>
        </h3>
        <ul className="plain">
          {rows.map((r) => (
            <li key={r}>
              <code>{r}</code>
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <>
      {part("Columns", list("columns"))}
      {part("Constraints", list("constraints"))}
      {indexes.length > 0 && (
        <section>
          <h3>
            Indexes <span className="n">{indexes.length}</span>
          </h3>
          <ul className="items">
            {indexes.map((x) => (
              <Row key={x.id} it={x} mark={mark} />
            ))}
          </ul>
        </section>
      )}
    </>
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
  const sys = n.role === "system" || n.role === "part" || n.role === "systems";
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
        {n.tables !== undefined ? (
          <>
            <dt>Tables</dt>
            <dd>{n.tables}</dd>
          </>
        ) : (
          n.kids.length > 0 &&
          !sys && (
            <>
              <dt>Files</dt>
              <dd>{n.files}</dd>
            </>
          )
        )}
        {typeof d?.attrs?.technology === "string" && (
          <>
            <dt>Runs on</dt>
            <dd>{d.attrs.technology}</dd>
          </>
        )}
        {n.role === "db" && (
          <>
            <dt>Migrations</dt>
            <dd>
              {String(d?.attrs?.migrations ?? 0)}
              {d?.attrs?.latest ? ` (latest ${d.attrs.latest})` : ""}
            </dd>
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
      {typeof d?.attrs?.description === "string" && <p className="about">{d.attrs.description}</p>}
      {d?.code?.length ? (
        <section>
          <h3>Code</h3>
          <Paths list={d.code} onGo={onGo} />
        </section>
      ) : null}
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
          {/* A leaf part's calls are its relations: list them once, with their code. */}
          {!(sys && !n.kids.length) && (
            <>
              <Links
                title={n.role === "table" ? "References" : sys ? "Calls" : "Uses"}
                list={d.uses}
                data={data}
                from={n.id}
                onGo={onGo}
              />
              <Links
                title={n.role === "table" ? "Referenced by" : sys ? "Called by" : "Used by"}
                list={d.usedBy}
                data={data}
                from={n.id}
                onGo={onGo}
              />
            </>
          )}
          <Seams list={d.seams} data={data} onGo={onGo} />
          {n.role === "table" && <Table attrs={d.attrs} indexes={d.indexes} mark={mark} />}
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
