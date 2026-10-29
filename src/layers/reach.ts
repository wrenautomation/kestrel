/**
 * What a handler reaches. Tables: a drizzle table it names (`from(leads)`, `insert(leads)`), or one
 * a SQL text names (`sql\`select … from leads\``), in its own body or in any repo function it
 * calls or passes by name, read through to the end. Each function is read once (memo); a cycle reads what it has.
 * A call the checker cannot pin to a body (an injected dep's method, a parameter) ends the walk:
 * those tables are missed. `write`: an insert, update or delete of it.
 * Table ids are the schema layer's (`table:<schema>.<name>`); a name it lacks is left out.
 * Outside: `npm`, each package a reached call resolves into (its declaration in node_modules);
 * `hosts`, each URL host in a string that is sent: a fetch-like call's first argument, or a
 * const named like a base URL (a link built for a page is not a call). The systems layer maps packages to systems.
 */
import { Node, type Project, SyntaxKind, type Node as TsNode } from "ts-morph";

export interface Reach {
  /** Table id → whether something writes it. */
  tables: Map<string, boolean>;
  npm: Set<string>;
  hosts: Set<string>;
  /** Names in `keys` it reads: the deps fields a factory hands its routes (`deps.files`). */
  deps: Set<string>;
}

const TABLE_CALL = /^(?:pgTable|pgView|pgMaterializedView|(\w+)\.(?:table|view|materializedView))$/;
const SQL = /\b(?:select|insert|update|delete|with)\b/i;
const SQL_TABLE =
  /\b(delete\s+from|from|join|into|update)\s+((?:"?[a-z_][\w]*"?\.)?"?[a-z_][\w]*"?)/gi;
const WRITE_CALL = /^(?:insert|update|delete)$/;
const HOST = /\bhttps?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
const SENDS = /^(?:fetch|request|get|post|put|patch|delete|send)$/i;
const BASE = /(?:url|base|endpoint|api|host)$/i;
/** Whether a string literal is sent (see the header). */
const sent = (n: TsNode) => {
  const p = n.getParent();
  if (Node.isCallExpression(p) && p.getArguments()[0] === n) {
    const c = p.getExpression();
    const name = Node.isPropertyAccessExpression(c) ? c.getName() : c.getText();
    return SENDS.test(name);
  }
  return Node.isVariableDeclaration(p) && BASE.test(p.getName());
};
/** The package a node_modules path is in: the last `node_modules/` (pnpm nests them). */
const PKG = /.*\/node_modules\/((?:@[^/]+\/)?[^/]+)\//;

type Fn = TsNode;

export function reader(
  project: Project,
  tables: ReadonlySet<string>,
  /** Deps field names to note when read (see `Reach.deps`). */
  keys: ReadonlySet<string> = new Set(),
) {
  // drizzle declarations: the const that holds the table → its id
  const byDecl = new Map<TsNode, string>();
  const names = new Set<string>();
  const schemaOf = (v: string, at: TsNode) => {
    const d = at
      .getSourceFile()
      .getVariableDeclaration(v)
      ?.getInitializer()
      ?.asKind(SyntaxKind.CallExpression);
    const lit = d?.getArguments()[0]?.asKind(SyntaxKind.StringLiteral);
    return d?.getExpression().getText() === "pgSchema" && lit ? lit.getLiteralValue() : undefined;
  };
  for (const file of project.getSourceFiles())
    for (const v of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const call = v.getInitializer()?.asKind(SyntaxKind.CallExpression);
      const m = call && TABLE_CALL.exec(call.getExpression().getText());
      const lit = m && call.getArguments()[0]?.asKind(SyntaxKind.StringLiteral);
      if (!m || !lit) continue;
      const schema = m[1] ? schemaOf(m[1], v) : "public";
      const id = schema && `table:${schema}.${lit.getLiteralValue()}`;
      if (!id || !tables.has(id)) continue;
      byDecl.set(v, id);
      names.add(v.getName());
    }

  const declOf = (e: TsNode) => {
    // `api.view`: the checker names the property, not the whole access
    const n = Node.isPropertyAccessExpression(e) ? e.getNameNode() : e;
    const s = n.getSymbol();
    return (s?.isAlias() ? s.getAliasedSymbol() : s)?.getDeclarations()[0];
  };
  const own = (d: TsNode) => {
    const f = d.getSourceFile();
    return !f.isDeclarationFile() && !f.getFilePath().includes("/node_modules/");
  };
  const pkgOf = (d: TsNode | undefined) => {
    const p = d && PKG.exec(d.getSourceFile().getFilePath())?.[1];
    return p && p !== "typescript" && !p.startsWith("@types/") && !p.endsWith("-types")
      ? p
      : undefined;
  };
  /** The function a declaration names: itself, a const's or a property's value, a wrapper's last function. */
  const bodyOf = (d: TsNode | undefined, depth = 0): Fn | undefined => {
    if (!d || depth > 3 || !own(d)) return undefined;
    if (
      Node.isFunctionDeclaration(d) ||
      Node.isMethodDeclaration(d) ||
      Node.isArrowFunction(d) ||
      Node.isFunctionExpression(d)
    )
      return d;
    if (Node.isVariableDeclaration(d) || Node.isPropertyAssignment(d)) {
      const init = d.getInitializer();
      if (!init) return undefined;
      if (Node.isCallExpression(init))
        return [...init.getArguments()]
          .reverse()
          .map((a) => bodyOf(a, depth + 1))
          .find(Boolean);
      return Node.isIdentifier(init) ? bodyOf(declOf(init), depth + 1) : bodyOf(init, depth + 1);
    }
    if (Node.isShorthandPropertyAssignment(d)) {
      const v = d.getValueSymbol()?.getDeclarations()[0];
      return bodyOf(v, depth + 1);
    }
    return undefined;
  };

  /** `read("home")` into a body that calls `api[route]`: the literal picks `api.home`. */
  const picks = (body: Fn, call: TsNode): Fn[] => {
    if (!Node.isCallExpression(call) && !Node.isNewExpression(call)) return [];
    if (!Node.isFunctionLikeDeclaration(body)) return [];
    const params = body.getParameters();
    const out: Fn[] = [];
    for (const [i, a] of (call.getArguments() ?? []).entries()) {
      const p = params[i];
      if (!p || !(Node.isStringLiteral(a) || Node.isNoSubstitutionTemplateLiteral(a))) continue;
      const name = p.getName();
      for (const ea of body.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
        if (ea.getArgumentExpression()?.getText() !== name) continue;
        const prop = ea.getExpression().getType().getProperty(a.getLiteralText());
        const fn = bodyOf(prop?.getDeclarations()[0]);
        if (fn) out.push(fn);
      }
    }
    return out;
  };

  const memo = new Map<Fn, Reach>();
  const strings = (text: string, out: Reach, at: TsNode) => {
    if (sent(at))
      for (const m of text.matchAll(HOST)) out.hosts.add((m[1] as string).toLowerCase());
    if (!SQL.test(text)) return;
    for (const m of text.matchAll(SQL_TABLE)) {
      const raw = (m[2] as string).replace(/"/g, "").toLowerCase();
      const id = `table:${raw.includes(".") ? raw : `public.${raw}`}`;
      if (!tables.has(id)) continue;
      const w = !/^(?:from|join)$/i.test(m[1] as string);
      out.tables.set(id, (out.tables.get(id) ?? false) || w);
    }
  };
  const merge = (out: Reach, from: Reach) => {
    for (const [k, w] of from.tables) out.tables.set(k, (out.tables.get(k) ?? false) || w);
    for (const p of from.npm) out.npm.add(p);
    for (const h of from.hosts) out.hosts.add(h);
    for (const k of from.deps) out.deps.add(k);
  };

  const read = (root: Fn): Reach => {
    // a name (`rows: steps`): walk the function it names
    const fn =
      Node.isIdentifier(root) || Node.isPropertyAccessExpression(root)
        ? (bodyOf(declOf(root)) ?? root)
        : root;
    const got = memo.get(fn);
    if (got) return got;
    const out: Reach = { tables: new Map(), npm: new Set(), hosts: new Set(), deps: new Set() };
    memo.set(fn, out);
    const visit = (n: TsNode) => {
      if (Node.isIdentifier(n)) {
        // by name only, no checker: the route's factory keeps its own fields
        if (keys.has(n.getText())) out.deps.add(n.getText());
        if (!names.has(n.getText())) return;
        const id = byDecl.get(declOf(n) as TsNode);
        if (!id) return;
        // `db.insert(t)`: the table is the call's argument, the call's name the verb
        const call = n.getParentIfKind(SyntaxKind.CallExpression);
        const callee = call?.getExpression();
        const verb = callee && Node.isPropertyAccessExpression(callee) ? callee.getName() : "";
        out.tables.set(id, (out.tables.get(id) ?? false) || WRITE_CALL.test(verb));
      } else if (Node.isNoSubstitutionTemplateLiteral(n) || Node.isStringLiteral(n)) {
        strings(n.getLiteralText(), out, n);
      } else if (Node.isTemplateExpression(n)) {
        strings(
          [n.getHead(), ...n.getTemplateSpans().map((s) => s.getLiteral())]
            .map((p) => p.getLiteralText())
            .join(" "),
          out,
          n,
        );
      } else if (Node.isCallExpression(n) || Node.isNewExpression(n)) {
        // the callee, and a function passed by name (`read(api.accounts)`): it is called in there
        for (const e of [n.getExpression(), ...(n.getArguments() ?? [])]) {
          if (
            e !== n.getExpression() &&
            !Node.isIdentifier(e) &&
            !Node.isPropertyAccessExpression(e)
          )
            continue;
          const d = declOf(e);
          const body = bodyOf(d);
          if (body && body !== fn) merge(out, read(body));
          if (body && e === n.getExpression()) for (const p of picks(body, n)) merge(out, read(p));
          const pkg = e === n.getExpression() ? pkgOf(d) : undefined;
          if (pkg) out.npm.add(pkg);
        }
      }
    };
    // a value root (`wrap(api.add)`) is a call itself
    visit(fn);
    fn.forEachDescendant(visit);
    return out;
  };
  return read;
}
