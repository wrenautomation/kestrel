/**
 * Tables, columns, keys and indexes, from `tbls out -t json` on a migrated Postgres. A live
 * database, not the Drizzle files: indexes and constraints a migration added by hand show too.
 * The layer starts its own throwaway Postgres (testcontainers), runs the repo's migrate command
 * against it, reads it with tbls in a container on the same network, and stops it. Set the
 * `urlEnv` var to read a database you already migrated instead (CI).
 * Nodes: `schema`, `table` (attrs: kind, columns as `name type [null] [= default]`,
 * constraints), `index` (attrs: def). Edges: `references` per foreign key, with the column
 * pair. Each file in the migrations folder is a `migration` node, so the high-level view shows
 * where the shape comes from. Groups: one per schema, and `migrations`.
 */
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { Edge, Graph, Node } from "../graph.js";
import type { Layer, LayerContext } from "./layer.js";

const run = promisify(execFile);

/** The part of tbls' JSON the layer reads. */
export interface Tbls {
  tables: {
    name: string;
    type: string;
    /** `COMMENT ON TABLE`: the box's one-liner. */
    comment?: string;
    columns: { name: string; type: string; nullable: boolean; default?: string | null }[];
    indexes?: { name: string; def: string }[];
    constraints?: { name: string; type: string; def: string }[];
  }[];
  relations?: {
    table: string;
    columns: string[];
    parent_table: string;
    parent_columns: string[];
  }[];
}

const MIGRATIONS = "migrations";

/** `public.leads` → schema `public`, name `leads`; tbls leaves the default schema off at times. */
const split = (t: string): [string, string] => {
  const i = t.indexOf(".");
  return i < 0 ? ["public", t] : [t.slice(0, i), t.slice(i + 1)];
};
const tableId = (t: string) => `table:${split(t).join(".")}`;

export interface Pick {
  schemas?: readonly string[] | undefined;
  skip?: readonly string[] | undefined;
}

export function fromTbls(t: Tbls, pick: Pick = {}, migrations: string[] = []): Graph {
  const nodes: Node[] = [];
  const pairs = new Map<string, Edge & { attrs: { columns: string[] } }>();
  const found = [...new Set(t.tables.map((tb) => split(tb.name)[0]))].sort();
  const schemas = (pick.schemas ?? found).filter((s) => !pick.skip?.includes(s));
  const keep = (name: string) => schemas.includes(split(name)[0]);
  for (const s of schemas) nodes.push({ id: `schema:${s}`, role: "schema", group: s });
  for (const tb of t.tables) {
    if (!keep(tb.name)) continue;
    const [s] = split(tb.name);
    const id = tableId(tb.name);
    nodes.push({
      id,
      role: "table",
      parent: `schema:${s}`,
      group: s,
      attrs: {
        kind: tb.type === "VIEW" ? "view" : tb.type === "MATERIALIZED VIEW" ? "matview" : "table",
        columns: tb.columns.map(
          (c) =>
            `${c.name} ${c.type}${c.nullable ? " null" : ""}${c.default ? ` = ${c.default}` : ""}`,
        ),
        // Indexes are their own nodes; a primary or unique key shows both ways, as Postgres has it.
        constraints: (tb.constraints ?? []).map((c) => `${c.name}: ${c.def}`).sort(),
        ...(tb.comment ? { description: tb.comment } : {}),
      },
    });
    for (const ix of tb.indexes ?? [])
      nodes.push({
        id: `index:${split(tb.name).join(".")}.${ix.name}`,
        role: "index",
        parent: id,
        group: s,
        attrs: { def: ix.def },
      });
  }
  for (const r of t.relations ?? []) {
    if (!keep(r.table) || !keep(r.parent_table)) continue;
    // Two keys between the same tables are one edge: an edge's id is its ends and kind.
    const from = tableId(r.table);
    const to = tableId(r.parent_table);
    const e = pairs.get(`${from}\0${to}`) ?? {
      from,
      to,
      kind: "references",
      attrs: { columns: [] },
    };
    e.attrs.columns.push(
      r.columns.map((c, i) => `${c} → ${r.parent_columns[i] ?? "?"}`).join(", "),
    );
    pairs.set(`${from}\0${to}`, e);
  }
  const edges = [...pairs.values()];
  for (const m of migrations)
    nodes.push({ id: `migration:${m}`, role: "migration", group: MIGRATIONS });
  return { layer: "schema", nodes, edges };
}

/** tbls in a container; `network` is a docker network mode, `url` as seen from inside it. */
async function tbls(image: string, network: string, url: string): Promise<Tbls> {
  const { stdout } = await run(
    "docker",
    ["run", "--rm", "--network", network, image, "out", "-t", "json", url],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as Tbls;
}

/** A URL on this Mac, as a container sees it. */
const fromContainer = (url: string) =>
  url.replace(/@(localhost|127\.0\.0\.1)([:/])/, "@host.docker.internal$2");

async function extract(ctx: LayerContext): Promise<Graph> {
  const cfg = ctx.config.layers.schema;
  if (!cfg) throw new Error("schema: no `layers.schema` in kestrel.json");
  const migrations = cfg.migrations
    ? (await readdir(resolve(ctx.root, cfg.migrations))).filter((f) => f.endsWith(".sql")).sort()
    : [];
  const given = ctx.env[cfg.urlEnv];
  if (given) return fromTbls(await tbls(cfg.tbls, "bridge", fromContainer(given)), cfg, migrations);
  if (!cfg.migrate) throw new Error(`schema: set ${cfg.urlEnv}, or \`migrate\` in kestrel.json`);

  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const pg = await new PostgreSqlContainer(cfg.image).start();
  try {
    await run("sh", ["-c", cfg.migrate], {
      cwd: ctx.root,
      env: { ...ctx.env, [cfg.migrateUrlEnv]: pg.getConnectionUri() },
      maxBuffer: 64 * 1024 * 1024,
    });
    const inside = `postgres://${pg.getUsername()}:${pg.getPassword()}@localhost:5432/${pg.getDatabase()}?sslmode=disable`;
    return fromTbls(await tbls(cfg.tbls, `container:${pg.getId()}`, inside), cfg, migrations);
  } finally {
    await pg.stop();
  }
}

export const schema: Layer = {
  id: "schema",
  extract,
  render: (group) => page(group),
};

/** One schema: each table with its columns, keys out and indexes. Too many for a diagram. */
function page(g: Graph): Record<string, string> {
  const group = g.nodes[0]?.group;
  if (!group) return {};
  if (group === MIGRATIONS) {
    const lines = [`# Migrations`, "", `Files: ${g.nodes.length}.`, ""];
    for (const n of g.nodes) lines.push(`- ${n.id.slice("migration:".length)}`);
    return { "migrations.md": `${lines.join("\n")}\n` };
  }
  const tables = g.nodes.filter((n) => n.role === "table");
  const lines = [`# ${group}: schema`, "", `Tables and views: ${tables.length}.`, ""];
  const tick = (x: string) => `\`${x.replace(/`/g, "'")}\``;
  for (const t of tables) {
    lines.push(`## ${t.id.slice("table:".length)} (${t.attrs?.kind})`, "");
    for (const c of (t.attrs?.columns as readonly string[] | undefined) ?? [])
      lines.push(`- ${tick(c)}`);
    const refs = g.edges.filter((e) => e.from === t.id);
    if (refs.length) {
      lines.push("", "References:", "");
      for (const e of refs)
        lines.push(
          `- ${e.to.slice("table:".length)} (${((e.attrs?.columns as readonly string[]) ?? []).join("; ")})`,
        );
    }
    const ixs = g.nodes.filter((n) => n.parent === t.id);
    if (ixs.length) {
      lines.push("", "Indexes:", "");
      for (const i of ixs) lines.push(`- ${tick(String(i.attrs?.def))}`);
    }
    lines.push("");
  }
  return { [`${group}.md`]: lines.join("\n") };
}
