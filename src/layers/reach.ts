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
 * `calls`: each entry in `watch` it calls, a pattern rule's facts (cards.ts `PatternRule`). A name
 * matches the callee's name, resolved or not (`withSendKey(…)`, `x.sendOnce(…)`). `Type.method`
 * also needs the receiver's type named `Type`; `(_, !GET)` filters literal arguments by place: `_`
 * any, `X` the literal X, `!X` anything but the literal X (a non-literal passes). An argument
 * that is the walked function's own parameter is settled at each call into it, with the argument
 * given there (`call("GET", p)` into a `call(method, …)` wrapper); at the root it passes.
 */
import { Node, type Project, SyntaxKind, type Node as TsNode } from "ts-morph";

export interface Reach {
  /** Table id → whether something writes it. */
  tables: Map<string, boolean>;
  npm: Set<string>;
  hosts: Set<string>;
  /** Names in `keys` it reads: the deps fields a factory hands its routes (`deps.files`). */
  deps: Set<string>;
  calls: Set<string>;
  /** Watches whose filtered args are this function's params: its callers settle them. */
  open: Open[];
}

/** `at`: the argument's place in the call still to be checked. */
interface Check {
  at: number;
  arg: Watch["args"][number];
}
interface Open {
  spec: string;
  checks: Check[];
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

interface Watch {
  spec: string;
  type?: string;
  name: string;
  args: { not: boolean; lit: string }[];
}

const WATCH = /^(?:(\w+)\.)?(\w+)(?:\((.*)\))?$/;
export function watchOf(spec: string): Watch | undefined {
  const m = WATCH.exec(spec.trim());
  if (!m?.[2]) return undefined;
  const args = (m[3] ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) =>
      a === "_" ? { not: false, lit: "" } : { not: a.startsWith("!"), lit: a.replace(/^!/, "") },
    );
  return { spec, name: m[2], args, ...(m[1] ? { type: m[1] } : {}) };
}

/** The type's own name, or its alias's: `SiteClient` for a param typed `SiteClient`. */
const typeName = (n: TsNode) => {
  const t = n.getType();
  return (t.getAliasSymbol() ?? t.getSymbol())?.getName();
};

const argOk = (a: TsNode | undefined, w: Watch["args"][number]) => {
  if (!w.lit) return true;
  const lit =
    a && (Node.isStringLiteral(a) || Node.isNoSubstitutionTemplateLiteral(a))
      ? a.getLiteralText()
      : undefined;
  return w.not ? lit !== w.lit : lit === w.lit;
};

export function reader(
  project: Project,
  tables: ReadonlySet<string>,
  /** Deps field names to note when read (see `Reach.deps`). */
  keys: ReadonlySet<string> = new Set(),
  /** Callees to note (see `Reach.calls`). */
  watch: ReadonlySet<string> = new Set(),
) {
  const watched = new Map<string, Watch[]>();
  for (const s of watch) {
    const w = watchOf(s);
    if (w) watched.set(w.name, [...(watched.get(w.name) ?? []), w]);
  }
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

  /** A param of `fn` → its place; a nested named function's own param → `skip` (its callers settle it). */
  const paramOf = (a: TsNode | undefined, fn: Fn): number | "skip" | undefined => {
    const d = a && Node.isIdentifier(a) ? declOf(a) : undefined;
    if (!d || !Node.isParameterDeclaration(d)) return undefined;
    const owner = d.getParent();
    if (owner === fn)
      return Node.isFunctionLikeDeclaration(owner) ? owner.getParameters().indexOf(d) : undefined;
    const named =
      Node.isFunctionDeclaration(owner) ||
      Node.isMethodDeclaration(owner) ||
      Node.isVariableDeclaration(owner.getParent());
    return named && owner.getAncestors().includes(fn) ? "skip" : undefined;
  };
  /** A watch's checks at one call: met, failed, still open on `fn`'s params, or skipped. */
  const settle = (checks: Check[], args: TsNode[], fn: Fn): boolean | Check[] | "skip" => {
    const open: Check[] = [];
    for (const c of checks) {
      const a = args[c.at];
      const p = paramOf(a, fn);
      if (p === "skip") return "skip";
      if (p !== undefined) open.push({ at: p, arg: c.arg });
      else if (!argOk(a, c.arg)) return false;
    }
    return open.length ? open : true;
  };
  const note = (out: Reach, spec: string, r: ReturnType<typeof settle>) => {
    if (r === true) out.calls.add(spec);
    else if (Array.isArray(r)) out.open.push({ spec, checks: r });
  };

  const memo = new Map<Fn, Reach>();
  /** Whether `obj` is the object literal `fn` returns: a factory's API. */
  const returnedBy = (obj: TsNode | undefined, fn: Fn) => {
    if (!obj || !Node.isObjectLiteralExpression(obj)) return false;
    let at: TsNode | undefined = obj.getParent();
    while (
      at &&
      (Node.isParenthesizedExpression(at) ||
        Node.isAsExpression(at) ||
        Node.isSatisfiesExpression(at))
    )
      at = at.getParent();
    if (at === fn) return true;
    return (
      !!at &&
      Node.isReturnStatement(at) &&
      at.getFirstAncestor((a) => Node.isFunctionLikeDeclaration(a)) === fn
    );
  };
  /**
   * Read when called, not with `fn`: a nested named function (`const call = (m) => …`), or a
   * method of the object `fn` returns (a factory's API: `ads(ctx).insights` reads `insights` alone).
   */
  const ownLater = (n: TsNode, fn: Fn) => {
    if (Node.isFunctionDeclaration(n)) return true;
    if (!Node.isArrowFunction(n) && !Node.isFunctionExpression(n) && !Node.isMethodDeclaration(n))
      return false;
    const p = n.getParent();
    if (Node.isVariableDeclaration(p)) return true;
    const obj = Node.isMethodDeclaration(n)
      ? p
      : Node.isPropertyAssignment(p)
        ? p.getParent()
        : undefined;
    // a declared return type (`: ReplySender`) types `x.method` as the interface's: no body to read later
    return returnedBy(obj, fn) && !(Node.isFunctionLikeDeclaration(fn) && fn.getReturnTypeNode());
  };
  /** A call's callee or argument: the call branch reads it. */
  const isCallee = (r: TsNode) => {
    const p = r.getParent();
    const c = Node.isPropertyAccessExpression(p) && p.getNameNode() === r ? p : r;
    const call = c.getParent();
    return (
      (Node.isCallExpression(call) || Node.isNewExpression(call)) &&
      (call.getExpression() === c || (call.getArguments() ?? []).includes(c))
    );
  };
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
    for (const k of from.calls) out.calls.add(k);
  };

  const read = (root: Fn): Reach => {
    // a name (`rows: steps`): walk the function it names
    const fn =
      Node.isIdentifier(root) || Node.isPropertyAccessExpression(root)
        ? (bodyOf(declOf(root)) ?? root)
        : root;
    const got = memo.get(fn);
    if (got) return got;
    const out: Reach = {
      tables: new Map(),
      npm: new Set(),
      hosts: new Set(),
      deps: new Set(),
      calls: new Set(),
      open: [],
    };
    memo.set(fn, out);
    const visit = (n: TsNode) => {
      if (Node.isIdentifier(n)) {
        // by name only, no checker: the route's factory keeps its own fields
        if (keys.has(n.getText())) out.deps.add(n.getText());
        // a function handed over in an object (`run({ step })`): read in, its args unknown
        const p = n.getParent();
        if (
          (Node.isShorthandPropertyAssignment(p) ||
            (Node.isPropertyAssignment(p) && p.getInitializer() === n)) &&
          !returnedBy(p.getParent(), fn)
        ) {
          const body = bodyOf(Node.isShorthandPropertyAssignment(p) ? p : declOf(n));
          if (body && body !== fn) {
            const got = read(body);
            merge(out, got);
            for (const o of got.open) out.calls.add(o.spec);
          }
        }
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
        const c = n.getExpression();
        const ws = watched.get(Node.isPropertyAccessExpression(c) ? c.getName() : c.getText());
        for (const w of ws ?? []) {
          if (
            w.type &&
            !(Node.isPropertyAccessExpression(c) && typeName(c.getExpression()) === w.type)
          )
            continue;
          const checks = w.args.flatMap((arg, at) => (arg.lit ? [{ at, arg }] : []));
          note(out, w.spec, settle(checks, n.getArguments() ?? [], fn));
        }
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
          if (body && body !== fn) {
            const got = read(body);
            merge(out, got);
            // passed by name: its args are unknown here
            for (const o of got.open)
              note(
                out,
                o.spec,
                e === n.getExpression() ? settle(o.checks, n.getArguments() ?? [], fn) : true,
              );
          }
          if (body && e === n.getExpression())
            for (const p of picks(body, n)) {
              const got = read(p);
              merge(out, got);
              for (const o of got.open) out.calls.add(o.spec);
            }
          const pkg = e === n.getExpression() ? pkgOf(d) : undefined;
          if (pkg) out.npm.add(pkg);
        }
      }
    };
    // a value root (`wrap(api.add)`) is a call itself
    visit(fn);
    const later: Fn[] = [];
    fn.forEachDescendant((n, t) => {
      if (n !== fn && ownLater(n, fn)) {
        later.push(n);
        t.skip();
      } else visit(n);
    });
    // a nested function named but not called here (`run({ step })`): read in, its args unknown
    for (const f of later) {
      const name = Node.isFunctionDeclaration(f)
        ? f.getNameNode()
        : f.getParentIfKind(SyntaxKind.VariableDeclaration)?.getNameNode();
      if (!name || !Node.isIdentifier(name)) continue;
      const named = name.findReferencesAsNodes().some(
        (r) =>
          r !== name &&
          r.getAncestors().includes(fn) &&
          // `return { setStatus }`: the API names it; a caller reads it as `api.setStatus`
          !returnedBy(r.getParent()?.getParent(), fn) &&
          !later.some((l) => r.getAncestors().includes(l)) &&
          !isCallee(r),
      );
      if (!named) continue;
      const got = read(f);
      merge(out, got);
      for (const o of got.open) out.calls.add(o.spec);
    }
    return out;
  };
  // the root's own params are unknown: what is still open passes
  return (root: Fn): Reach => {
    const r = read(root);
    return r.open.length ? { ...r, calls: new Set([...r.calls, ...r.open.map((o) => o.spec)]) } : r;
  };
}
