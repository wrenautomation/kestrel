/**
 * What can be called from outside a process: Restate handlers and HTTP routes. They are
 * registered, not exported, so `api` misses them. Read with ts-morph from the registration call:
 * `restate.service|object|workflow({ name, handlers: { h: wrap({...}, (ctx, req: In): Promise<Out>) } })`,
 * or a repo's own wrapper of it called the same way (`portalService({ name, handlers })`).
 * A spread in `handlers` (`...viewAsHandlers(api)`) is read through: the object a const holds or
 * a function returns.
 * Nodes: `service`, and a `route` per handler (attrs: input and output type text). Edges:
 * route → table, `reads` or `writes` (./reach.ts), when the schema layer runs; calls between
 * services are the `systems` layer's. Route attrs `npm` and `hosts`: what it calls outside. A
 * package more than a quarter of the routes reach is the stack (the SDK, the ORM), left out.
 * Service attr `factory`: the named function the registration sits in. Route attr `deps`: the
 * fields of the factory's first parameter the route's walk names. Route attr `reaches`: the names
 * a pattern card's rule asks about that the walk calls (layers/patterns.ts).
 */
import { relative } from "node:path";
import {
  type ArrowFunction,
  type CallExpression,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  SyntaxKind,
  Node as TsNode,
} from "ts-morph";
import { patternCards } from "../cards.js";
import type { Edge, Graph, Node } from "../graph.js";
import type { Layer } from "./layer.js";
import { reader } from "./reach.js";
import { flat, packages, pkgSections, SOURCE, tsProject } from "./workspace.js";

const REGISTER = /^(?:restate\.)?(service|object|workflow)$/;

type Fn = ArrowFunction | FunctionExpression | FunctionDeclaration;

/**
 * The named function that registers a service (`makeNotesConsole`) and its first parameter's
 * fields: the systems layer reads its calls.
 */
function factoryOf(call: CallExpression): { name: string; fields: Set<string> } | undefined {
  const f = call.getFirstAncestor(
    (n) =>
      TsNode.isFunctionDeclaration(n) ||
      TsNode.isArrowFunction(n) ||
      TsNode.isFunctionExpression(n),
  );
  if (!f) return undefined;
  const v = f.getParent();
  const name = TsNode.isFunctionDeclaration(f)
    ? f.getName()
    : v && TsNode.isVariableDeclaration(v)
      ? v.getName()
      : undefined;
  if (!name) return undefined;
  const p = f.getParameters()[0];
  return {
    name,
    fields: new Set(
      p
        ?.getType()
        .getProperties()
        .map((s) => s.getName()) ?? [],
    ),
  };
}

/** The handler function: the value itself, the last function argument of a wrapper, or a named one. */
function handlerFn(v: Expression | undefined): Fn | undefined {
  if (!v) return undefined;
  if (TsNode.isArrowFunction(v) || TsNode.isFunctionExpression(v)) return v;
  if (TsNode.isCallExpression(v))
    return [...v.getArguments()]
      .reverse()
      .map((a) => handlerFn(a as Expression))
      .find(Boolean);
  if (TsNode.isIdentifier(v)) {
    const d = v.getSymbol()?.getDeclarations()[0];
    if (d && TsNode.isFunctionDeclaration(d)) return d;
    if (d && TsNode.isVariableDeclaration(d)) return handlerFn(d.getInitializer());
  }
  return undefined;
}

/** `Promise<X>` → `X`: every handler is async, so the wrapper says nothing. */
const unwrap = (t: string) => t.replace(/^Promise<([\s\S]*)>$/, "$1");

function io(fn: Fn): { input: string; output: string } {
  const p = fn.getParameters()[1];
  const input = p ? flat(p.getTypeNode()?.getText() ?? p.getType().getText(p)) : "void";
  const output = flat(unwrap(fn.getReturnTypeNode()?.getText() ?? fn.getReturnType().getText(fn)));
  return { input, output };
}

/** The object literal an expression gives: itself, a const's value, or what a called function returns. */
function literalOf(e: TsNode | undefined, depth = 0): ObjectLiteralExpression | undefined {
  if (!e || depth > 4) return undefined;
  if (TsNode.isObjectLiteralExpression(e)) return e;
  if (
    TsNode.isParenthesizedExpression(e) ||
    TsNode.isAsExpression(e) ||
    TsNode.isSatisfiesExpression(e)
  )
    return literalOf(e.getExpression(), depth + 1);
  const target = TsNode.isCallExpression(e) ? e.getExpression() : e;
  const sym = target.getSymbol();
  // an imported name: its own declaration, in the file it comes from
  const d = (sym?.isAlias() ? sym.getAliasedSymbol() : sym)?.getDeclarations()[0];
  if (!d) return undefined;
  if (TsNode.isVariableDeclaration(d)) {
    const init = d.getInitializer();
    if (!TsNode.isCallExpression(e)) return literalOf(init, depth + 1);
    if (init && (TsNode.isArrowFunction(init) || TsNode.isFunctionExpression(init)))
      return returned(init, depth);
    return undefined;
  }
  if (TsNode.isCallExpression(e) && TsNode.isFunctionDeclaration(d)) return returned(d, depth);
  return undefined;
}

function returned(fn: Fn, depth: number): ObjectLiteralExpression | undefined {
  const body = fn.getBody();
  if (body && !TsNode.isBlock(body)) return literalOf(body, depth + 1);
  const ret = body
    ?.getDescendantsOfKind(SyntaxKind.ReturnStatement)
    .find((r) => r.getFirstAncestorByKind(SyntaxKind.Block) === body);
  return literalOf(ret?.getExpression(), depth + 1);
}

/** An object's members, spreads read through (see the header). */
function members(obj: ObjectLiteralExpression, depth = 0): ObjectLiteralElementLike[] {
  return obj.getProperties().flatMap((p) => {
    if (!TsNode.isSpreadAssignment(p)) return [p];
    const inner = depth < 4 ? literalOf(p.getExpression()) : undefined;
    return inner ? members(inner, depth + 1) : [];
  });
}

/** Share of routes past which a package is the stack, not a dependency of one route. */
const STACK = 0.25;

const tableIds = (schema: Graph | null) =>
  (schema?.nodes ?? []).filter((n) => n.role === "table").map((n) => n.id);

const prop = (obj: TsNode, name: string) =>
  TsNode.isObjectLiteralExpression(obj) ? obj.getProperty(name) : undefined;

/** A wrapper's literal options (`{ effect: "sends", ingressPrivate: true }`) as `key:value` tags. */
function tagsOf(call: CallExpression): string[] {
  const o = call.getArguments()[0];
  if (!o || !TsNode.isObjectLiteralExpression(o)) return [];
  return o.getProperties().flatMap((p) => {
    if (!TsNode.isPropertyAssignment(p)) return [];
    const v = p.getInitializer();
    if (v && (TsNode.isStringLiteral(v) || TsNode.isNoSubstitutionTemplateLiteral(v)))
      return [`${p.getName()}:${v.getLiteralText()}`];
    if (v && (TsNode.isTrueLiteral(v) || TsNode.isFalseLiteral(v)))
      return [`${p.getName()}:${v.getText()}`];
    return [];
  });
}

/** A wrapper's call: one object with a `name` and a `handlers` object, as Restate's own takes. */
function wrapped(call: CallExpression): boolean {
  const arg = call.getArguments()[0];
  const h = arg && prop(arg, "handlers");
  return (
    !!arg &&
    !!prop(arg, "name") &&
    !!h &&
    TsNode.isPropertyAssignment(h) &&
    TsNode.isObjectLiteralExpression(h.getInitializerOrThrow())
  );
}

/** A literal, a const, or `SERVICE.name`: the checker gives the literal type. Any other name is a
 * wrapper's own body (`name: o.name`); its callers are read as services. */
function nameOf(call: CallExpression): string | undefined {
  const arg = call.getArguments()[0];
  const p = arg && prop(arg, "name");
  if (!p || !TsNode.isPropertyAssignment(p)) return undefined;
  const t = p.getInitializerOrThrow().getType();
  return t.isStringLiteral() ? String(t.getLiteralValue()) : undefined;
}

export const routes: Layer = {
  id: "routes",
  async sections({ root, config, prior }) {
    const opts = config.layers.routes ?? { packages: ["packages/*", "apps/*"] };
    const sections = await pkgSections(root, await packages(root, opts.packages), SOURCE);
    // table edges name the schema's tables
    const tables = JSON.stringify(tableIds(await prior("schema")));
    // and the pattern rules' names
    const { watch } = await patternCards(root, config.cards?.dir ?? "map");
    const names = [tables, JSON.stringify([...watch].sort())];
    return sections.map((s) => ({ ...s, names: [...(s.names ?? []), ...names] }));
  },
  async extract({ root, config, prior }, only) {
    const opts = config.layers.routes ?? { packages: ["packages/*", "apps/*"] };
    const pkgs = await packages(root, opts.packages);
    const project = tsProject(root, pkgs);
    const ownerOf = (path: string) => pkgs.find((p) => path.startsWith(p.dir));
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const tables = tableIds(await prior("schema"));
    // every factory's deps fields first: a shared function is read once, for all of them
    const registers = (call: CallExpression) =>
      Boolean((REGISTER.test(call.getExpression().getText()) || wrapped(call)) && nameOf(call));
    const keys = new Set<string>();
    for (const file of project.getSourceFiles())
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression))
        if (registers(call)) for (const k of factoryOf(call)?.fields ?? []) keys.add(k);
    const { watch } = await patternCards(root, config.cards?.dir ?? "map");
    const read = reader(project, new Set(tables), keys, watch);
    for (const file of project.getSourceFiles()) {
      const path = relative(root, file.getFilePath());
      const pkg = ownerOf(path);
      if (!pkg || (only && !only.has(pkg.name))) continue;
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression().getText();
        const own = REGISTER.exec(callee)?.[1];
        const kind = own ?? (wrapped(call) ? "service" : undefined);
        const name = kind && nameOf(call);
        if (!kind || !name) continue;
        // A name used twice shows as two services, never one merged.
        const sid = nodes.some((n) => n.id === `service:${name}`)
          ? `service:${name}@${path}`
          : `service:${name}`;
        const factory = factoryOf(call);
        nodes.push({
          id: sid,
          role: "service",
          parent: pkg.name,
          group: pkg.name,
          attrs: {
            kind,
            file: path,
            ...(own ? {} : { via: callee }),
            ...(factory ? { factory: factory.name } : {}),
          },
        });
        const handlers = prop(call.getArguments()[0] as TsNode, "handlers");
        const obj =
          handlers && TsNode.isPropertyAssignment(handlers) ? handlers.getInitializer() : undefined;
        if (!obj || !TsNode.isObjectLiteralExpression(obj)) continue;
        for (const h of members(obj)) {
          if (
            !(
              TsNode.isPropertyAssignment(h) ||
              TsNode.isShorthandPropertyAssignment(h) ||
              TsNode.isMethodDeclaration(h)
            )
          )
            continue;
          const value = TsNode.isPropertyAssignment(h)
            ? h.getInitializer()
            : TsNode.isShorthandPropertyAssignment(h)
              ? h.getNameNode()
              : undefined;
          const fn = TsNode.isMethodDeclaration(h) ? undefined : handlerFn(value);
          const shape = TsNode.isMethodDeclaration(h)
            ? {
                input: flat(h.getParameters()[1]?.getTypeNode()?.getText() ?? "void"),
                output: flat(
                  unwrap(h.getReturnTypeNode()?.getText() ?? h.getReturnType().getText(h)),
                ),
              }
            : fn
              ? io(fn)
              : { input: "?", output: "?" };
          const wrap =
            value && TsNode.isCallExpression(value) ? value.getExpression().getText() : "plain";
          const tags = value && TsNode.isCallExpression(value) ? tagsOf(value) : [];
          const id = `route:${sid.slice("service:".length)}/${h.getName()}`;
          nodes.push({
            id,
            role: "route",
            parent: sid,
            group: pkg.name,
            attrs: { ...shape, wrap, ...(tags.length ? { tags } : {}) },
          });
          // no inline function (`read(api.accounts)`): the walk starts at the value
          const body = TsNode.isMethodDeclaration(h) ? h : (fn ?? value);
          const r = body ? read(body) : undefined;
          for (const [to, write] of r?.tables ?? [])
            edges.push({ from: id, to, kind: write ? "writes" : "reads" });
          const route = nodes.at(-1) as Node;
          if (r?.npm.size) route.attrs = { ...route.attrs, npm: [...r.npm].sort() };
          if (r?.hosts.size) route.attrs = { ...route.attrs, hosts: [...r.hosts].sort() };
          const deps = [...(r?.deps ?? [])].filter((k) => factory?.fields.has(k)).sort();
          if (deps.length) route.attrs = { ...route.attrs, deps };
          if (r?.calls.size) route.attrs = { ...route.attrs, reaches: [...r.calls].sort() };
        }
      }
    }
    const reached = new Map<string, number>();
    const all = nodes.filter((n) => n.role === "route");
    for (const n of all)
      for (const p of (n.attrs?.npm as string[] | undefined) ?? [])
        reached.set(p, (reached.get(p) ?? 0) + 1);
    for (const n of all) {
      const npm = ((n.attrs?.npm as string[] | undefined) ?? []).filter(
        (p) => (reached.get(p) ?? 0) <= all.length * STACK,
      );
      const { npm: _, ...rest } = n.attrs ?? {};
      n.attrs = npm.length ? { ...rest, npm } : rest;
    }
    edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    return { layer: "routes", nodes, edges };
  },
  render: (group) => page(group),
};

/** One package: each service it registers, each handler as `name(input) → output`. */
function page(g: Graph): Record<string, string> {
  const pkg = g.nodes[0]?.group;
  if (!pkg) return {};
  const services = g.nodes.filter((n) => n.role === "service");
  const lines = [`# ${pkg}: routes`, "", `Services: ${services.length}.`, ""];
  for (const s of services) {
    lines.push(
      `## ${s.id.slice("service:".length)} (${s.attrs?.kind}${s.attrs?.via ? ` via \`${s.attrs.via}\`` : ""})`,
      "",
      `File: ${s.attrs?.file}`,
      "",
    );
    for (const r of g.nodes.filter((n) => n.parent === s.id)) {
      const name = r.id.slice(r.id.lastIndexOf("/") + 1);
      const tick = (x: unknown) => `\`${String(x).replace(/`/g, "'")}\``;
      const touch = (kind: string) =>
        g.edges.filter((e) => e.from === r.id && e.kind === kind).map((e) => e.to.slice(6));
      const [w, rd] = [touch("writes"), touch("reads")];
      const db = [
        w.length ? `writes ${w.join(", ")}` : "",
        rd.length ? `reads ${rd.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      const list = (k: string) => ((r.attrs?.[k] as string[] | undefined) ?? []).join(", ");
      const out = [list("npm") && `npm ${list("npm")}`, list("hosts") && `hosts ${list("hosts")}`]
        .filter(Boolean)
        .join("; ");
      lines.push(
        `- **${name}** ${tick(r.attrs?.input)} → ${tick(r.attrs?.output)} (${r.attrs?.wrap})${db ? `: ${db}` : ""}`,
        ...(out ? [`  - outside: ${out}`] : []),
      );
    }
    lines.push("");
  }
  return { [`${pkg.replace(/[/\\:]/g, "+")}.md`]: lines.join("\n") };
}
