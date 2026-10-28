/**
 * The screens and the stories, two halves of one question: what a person sees, and where each
 * part of it is drawn and shown alone.
 * Screens come from the repo's own dump command (`dump` in kestrel.json, run in the repo root):
 * a router built from data reads wrong statically, so the repo prints what it registers. It
 * prints `{areas: {<who>: [{id, label, apps}]}, apps: [{id, name, blurb, file, pages: [{id,
 * label, about?, group?, hidden?, template, record?, file?}]}]}`, paths from the repo root.
 * Stories are read statically from CSF files: the default export's `title` and `id`, and the
 * relative imports, which are the parts it shows (mocks and fixtures are not parts).
 * Nodes: `app` (`ui:<app>`), `screen` (`ui:<app>/<page>`, parent its app), `story`
 * (`story:<id>`). No edges: a screen's `file` and a story's `shows` are repo paths, which the
 * imports layer already links to the parts. Groups: one per app, `_stories` for the stories.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Attr, Graph, Node } from "../graph.js";
import type { Layer, LayerContext } from "./layer.js";

const run = promisify(execFile);

const Dump = z.object({
  areas: z.record(
    z.string(),
    z.array(z.object({ id: z.string(), label: z.string(), apps: z.array(z.string()) })),
  ),
  apps: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      blurb: z.string().optional(),
      file: z.string().optional(),
      /** The name the app is exported as: it names an app whose id another app shares. */
      export: z.string().optional(),
      /** `team`: Wren's own workspace only. Else a client's. */
      audience: z.string().optional(),
      parked: z.boolean().optional(),
      menu: z.boolean().optional(),
      pages: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          about: z.string().optional(),
          group: z.string().optional(),
          hidden: z.boolean().optional(),
          template: z.string(),
          record: z.string().optional(),
          file: z.string().optional(),
        }),
      ),
    }),
  ),
});
export type Dump = z.infer<typeof Dump>;

export interface Story {
  /** Repo-relative story file. */
  file: string;
  id: string;
  title: string;
  /** Repo-relative files it imports by a relative path. */
  shows: string[];
}

const set = (o: Record<string, Attr>, k: string, v: Attr | undefined) => {
  if (v !== undefined && v !== "" && v !== false) o[k] = v;
};

export function fromDump(d: Dump, stories: Story[]): Graph {
  const nodes: Node[] = [];
  // Each app's place in each sidebar: `team: Marketing`. The team sidebar holds team apps only,
  // so of two apps with one id each gets its own workspace's place.
  const areas = new Map<string, { team: boolean; at: string }[]>();
  for (const [who, list] of Object.entries(d.areas))
    for (const a of list)
      for (const app of a.apps)
        areas.set(app, [
          ...(areas.get(app) ?? []),
          { team: who === "team", at: `${who}: ${a.label}` },
        ]);
  // Two apps can share an id (one per workspace): each of them goes by its export name, or `<id>~<n>`.
  const count = new Map<string, number>();
  for (const app of d.apps) count.set(app.id, (count.get(app.id) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const app of d.apps) {
    const n = (seen.get(app.id) ?? 0) + 1;
    seen.set(app.id, n);
    const key = count.get(app.id) === 1 ? app.id : (app.export ?? `${app.id}~${n}`);
    const id = `ui:${key}`;
    const team = app.audience === "team";
    const attrs: Record<string, Attr> = { name: app.name, workspace: team ? "wren" : "client" };
    set(attrs, "blurb", app.blurb);
    set(attrs, "file", app.file);
    const at = (areas.get(app.id) ?? []).filter((a) => a.team === team).map((a) => a.at);
    set(attrs, "areas", at.length ? at : undefined);
    set(attrs, "parked", app.parked);
    set(attrs, "menu", app.menu);
    nodes.push({ id, role: "app", group: key, attrs });
    for (const [i, p] of app.pages.entries()) {
      // Ids sort; the tab order is kept here.
      const a: Record<string, Attr> = { label: p.label, template: p.template, order: i };
      set(a, "about", p.about);
      set(a, "group", p.group);
      set(a, "hidden", p.hidden);
      set(a, "record", p.record);
      set(a, "file", p.file);
      nodes.push({ id: `${id}/${p.id}`, role: "screen", parent: id, group: key, attrs: a });
    }
  }
  for (const s of stories)
    nodes.push({
      id: `story:${s.id}`,
      role: "story",
      group: "_stories",
      attrs: { title: s.title, file: s.file, shows: s.shows },
    });
  return { layer: "ui", nodes, edges: [] };
}

/** One CSF file: its meta's `title` and `id` (the file name when it has none), and its relative imports. */
export function readStory(root: string, file: string, text: string): Story {
  // `export default meta;` names a const above it: read the meta from there.
  const named = /export default\s+(\w+)\s*;/.exec(text)?.[1];
  const decl = named ? text.search(new RegExp(`\\b(?:const|let|var)\\s+${named}\\b`)) : -1;
  const meta = text.slice(decl >= 0 ? decl : text.search(/export default\b/));
  const title = /\btitle:\s*["'`]([^"'`]+)["'`]/.exec(meta)?.[1];
  const id = /\bid:\s*["'`]([^"'`]+)["'`]/.exec(meta)?.[1];
  const shows = new Set<string>();
  for (const m of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["'](\.[^"']+)["']/gm)) {
    const rel = (m[1] as string).replace(/\.js$/, "");
    const at = join(dirname(file), rel);
    const hit = ["", ".tsx", ".ts", "/index.tsx", "/index.ts"]
      .map((x) => at + x)
      .find((p) => /\.tsx?$/.test(p) && existsSync(join(root, p)));
    if (hit && !/[./](fixtures?|stories|mocks?)\b/.test(hit)) shows.add(hit);
  }
  const name = file.replace(/^.*\//, "").replace(/\.stories\.tsx?$/, "");
  return { file, id: id ?? name, title: title ?? name, shows: [...shows].sort() };
}

async function extract(ctx: LayerContext): Promise<Graph> {
  const cfg = ctx.config.layers.ui;
  if (!cfg) throw new Error("ui: no `layers.ui` in kestrel.json");
  const { stdout } = await run("sh", ["-c", cfg.dump], {
    cwd: ctx.root,
    env: ctx.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const dump = Dump.parse(JSON.parse(stdout));
  const stories: Story[] = [];
  for await (const f of glob(cfg.stories, { cwd: ctx.root })) {
    if (f.includes("node_modules")) continue;
    const file = relative(ctx.root, join(ctx.root, f));
    stories.push(readStory(ctx.root, file, await readFile(join(ctx.root, file), "utf8")));
  }
  return fromDump(dump, stories);
}

export const ui: Layer = { id: "ui", extract, render: (group) => page(group) };

/** One app: its pages in order, each with what it is for and where it is drawn. Or every story. */
function page(g: Graph): Record<string, string> {
  const group = g.nodes[0]?.group;
  if (!group) return {};
  const tick = (x: Attr | undefined) => (x ? `\`${x}\`` : "");
  if (group === "_stories") {
    const lines = ["# Stories", "", "| Story | File | Shows |", "|---|---|---|"];
    for (const n of g.nodes)
      lines.push(
        `| ${n.attrs?.title} | ${tick(n.attrs?.file)} | ${((n.attrs?.shows as readonly string[]) ?? []).map(tick).join(", ")} |`,
      );
    return { "_stories.md": `${lines.join("\n")}\n` };
  }
  const app = g.nodes.find((n) => n.role === "app");
  const lines = [`# ${app?.attrs?.name ?? group}: app, ${app?.attrs?.workspace} workspace`, ""];
  if (app?.attrs?.blurb) lines.push(String(app.attrs.blurb), "");
  const areas = app?.attrs?.areas as readonly string[] | undefined;
  if (areas?.length) lines.push(`Sidebar: ${areas.join("; ")}.`, "");
  if (app?.attrs?.file) lines.push(`Registered in ${tick(app.attrs.file)}.`, "");
  lines.push("| Page | Template | Drawn in | For |", "|---|---|---|---|");
  const screens = g.nodes.filter((x) => x.role === "screen");
  screens.sort((a, b) => Number(a.attrs?.order) - Number(b.attrs?.order));
  for (const n of screens) {
    const a = n.attrs ?? {};
    const tmpl = a.record ? `${a.template} of \`${a.record}\`` : String(a.template);
    lines.push(
      `| ${a.label}${a.hidden ? " (link only)" : ""} | ${tmpl} | ${tick(a.file)} | ${a.about ?? ""} |`,
    );
  }
  return { [`${group}.md`]: `${lines.join("\n")}\n` };
}
