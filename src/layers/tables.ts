/**
 * The tables a handler reaches: a drizzle table it names (`from(leads)`, `insert(leads)`), or one
 * a SQL text names (`sql\`select … from leads\``), in its own body or in any repo function it
 * calls or passes by name, read through to the end. Each function is read once (memo); a cycle reads what it has.
 * A call the checker cannot pin to a body (an injected dep's method, a parameter) ends the walk:
 * those tables are missed. `write`: an insert, update or delete of it.
 * Table ids are the schema layer's (`table:<schema>.<name>`); a name it lacks is left out.
 */
import { Node, type Project, SyntaxKind, type Node as TsNode } from "ts-morph";

/** Table id → whether something writes it. */
export type Touch = Map<string, boolean>;

const TABLE_CALL = /^(?:pgTable|pgView|pgMaterializedView|(\w+)\.(?:table|view|materializedView))$/;
const SQL = /\b(?:select|insert|update|delete|with)\b/i;
const SQL_TABLE =
  /\b(delete\s+from|from|join|into|update)\s+((?:"?[a-z_][\w]*"?\.)?"?[a-z_][\w]*"?)/gi;
const WRITE_CALL = /^(?:insert|update|delete)$/;

type Fn = TsNode;

export function tableReader(project: Project, tables: ReadonlySet<string>) {
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

  const memo = new Map<Fn, Touch>();
  const sqlTables = (text: string, out: Touch) => {
    if (!SQL.test(text)) return;
    for (const m of text.matchAll(SQL_TABLE)) {
      const raw = (m[2] as string).replace(/"/g, "").toLowerCase();
      const id = `table:${raw.includes(".") ? raw : `public.${raw}`}`;
      if (!tables.has(id)) continue;
      const w = !/^(?:from|join)$/i.test(m[1] as string);
      out.set(id, (out.get(id) ?? false) || w);
    }
  };
  const merge = (out: Touch, from: Touch) => {
    for (const [k, w] of from) out.set(k, (out.get(k) ?? false) || w);
  };

  const read = (fn: Fn): Touch => {
    const got = memo.get(fn);
    if (got) return got;
    const out: Touch = new Map();
    memo.set(fn, out);
    const visit = (n: TsNode) => {
      if (Node.isIdentifier(n)) {
        if (!names.has(n.getText())) return;
        const id = byDecl.get(declOf(n) as TsNode);
        if (!id) return;
        // `db.insert(t)`: the table is the call's argument, the call's name the verb
        const call = n.getParentIfKind(SyntaxKind.CallExpression);
        const callee = call?.getExpression();
        const verb = callee && Node.isPropertyAccessExpression(callee) ? callee.getName() : "";
        out.set(id, (out.get(id) ?? false) || WRITE_CALL.test(verb));
      } else if (Node.isNoSubstitutionTemplateLiteral(n) || Node.isStringLiteral(n)) {
        sqlTables(n.getLiteralText(), out);
      } else if (Node.isTemplateExpression(n)) {
        sqlTables(
          [n.getHead(), ...n.getTemplateSpans().map((s) => s.getLiteral())]
            .map((p) => p.getLiteralText())
            .join(" "),
          out,
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
          const body = bodyOf(declOf(e));
          if (body && body !== fn) merge(out, read(body));
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
