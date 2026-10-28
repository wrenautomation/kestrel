/**
 * What can be called from outside a process: Restate handlers and HTTP routes. They are
 * registered, not exported, so `api` misses them. Read with ts-morph from the registration call:
 * `restate.service|object|workflow({ name, handlers: { h: wrap({...}, (ctx, req: In): Promise<Out>) } })`.
 * Nodes: `service`, and a `route` per handler (attrs: input and output type text). Edges: none
 * yet; calls between services are the `systems` layer's.
 */
import { relative } from "node:path";
import {
  type ArrowFunction,
  type CallExpression,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  SyntaxKind,
  Node as TsNode,
} from "ts-morph";
import type { Graph, Node } from "../graph.js";
import type { Layer } from "./layer.js";
import { flat, packages, tsProject } from "./workspace.js";

const REGISTER = /^(?:restate\.)?(service|object|workflow)$/;

type Fn = ArrowFunction | FunctionExpression | FunctionDeclaration;

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

const prop = (obj: TsNode, name: string) =>
  TsNode.isObjectLiteralExpression(obj) ? obj.getProperty(name) : undefined;

/** A name may be a literal or a const; anything else shows as its source text. */
function nameOf(call: CallExpression): string | undefined {
  const arg = call.getArguments()[0];
  const p = arg && prop(arg, "name");
  if (!p || !TsNode.isPropertyAssignment(p)) return undefined;
  const v = p.getInitializerOrThrow();
  // A literal, a const, or `SERVICE.name`: the checker gives the literal type.
  const t = v.getType();
  if (t.isStringLiteral()) return String(t.getLiteralValue());
  return flat(v.getText());
}

export const routes: Layer = {
  id: "routes",
  async extract({ root, config }) {
    const opts = config.layers.routes ?? { packages: ["packages/*", "apps/*"] };
    const pkgs = await packages(root, opts.packages);
    const project = tsProject(root, pkgs);
    const ownerOf = (path: string) => pkgs.find((p) => path.startsWith(p.dir));
    const nodes: Node[] = [];
    for (const file of project.getSourceFiles()) {
      const path = relative(root, file.getFilePath());
      const pkg = ownerOf(path);
      if (!pkg) continue;
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const kind = REGISTER.exec(call.getExpression().getText())?.[1];
        const name = kind && nameOf(call);
        if (!kind || !name) continue;
        // A name used twice shows as two services, never one merged.
        const sid = nodes.some((n) => n.id === `service:${name}`)
          ? `service:${name}@${path}`
          : `service:${name}`;
        nodes.push({
          id: sid,
          role: "service",
          parent: pkg.name,
          group: pkg.name,
          attrs: { kind, file: path },
        });
        const handlers = prop(call.getArguments()[0] as TsNode, "handlers");
        const obj =
          handlers && TsNode.isPropertyAssignment(handlers) ? handlers.getInitializer() : undefined;
        if (!obj || !TsNode.isObjectLiteralExpression(obj)) continue;
        for (const h of obj.getProperties()) {
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
          nodes.push({
            id: `route:${sid.slice("service:".length)}/${h.getName()}`,
            role: "route",
            parent: sid,
            group: pkg.name,
            attrs: { ...shape, wrap },
          });
        }
      }
    }
    return { layer: "routes", nodes, edges: [] };
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
      `## ${s.id.slice("service:".length)} (${s.attrs?.kind})`,
      "",
      `File: ${s.attrs?.file}`,
      "",
    );
    for (const r of g.nodes.filter((n) => n.parent === s.id)) {
      const name = r.id.slice(r.id.lastIndexOf("/") + 1);
      const tick = (x: unknown) => `\`${String(x).replace(/`/g, "'")}\``;
      lines.push(
        `- **${name}** ${tick(r.attrs?.input)} → ${tick(r.attrs?.output)} (${r.attrs?.wrap})`,
      );
    }
    lines.push("");
  }
  return { [`${pkg.replace(/[/\\:]/g, "+")}.md`]: lines.join("\n") };
}
