/**
 * Each package's public interface, read from source with ts-morph: every name its `exports`
 * entries give out, with its declared signature. Source, not `.d.ts`: wren runs untranspiled.
 * Nodes: `export` (attrs: entry, declaration kind, signature text). Edges: none yet.
 */
import { relative } from "node:path";
import { type ExportedDeclarations, SyntaxKind, Node as TsNode } from "ts-morph";
import type { Graph, Node } from "../graph.js";
import type { Layer } from "./layer.js";
import { flat, packages, tsProject } from "./workspace.js";

/** Where the code declares no type, the checker's text is cut here: Drizzle and zod types run to 30 kB. */
const INFERRED_MAX = 300;

/**
 * The shape you review: parameters and return for code, the body for a type. Never a function body.
 * `inferred`: some part has no declared type, so the text is the checker's, cut to INFERRED_MAX.
 */
function signature(d: ExportedDeclarations): { kind: string; sig: string; inferred: boolean } {
  let inferred = false;
  const declared = (node: TsNode | undefined, infer: () => string) => {
    if (node) return node.getText();
    inferred = true;
    const t = flat(infer());
    return t.length > INFERRED_MAX ? `${t.slice(0, INFERRED_MAX)}…` : t;
  };
  type Fnish = {
    getParameters(): TsNode[];
    getReturnTypeNode(): TsNode | undefined;
    getReturnType(): { getText(n?: TsNode): string };
  };
  const fn = (f: Fnish & TsNode, params = f.getParameters()) =>
    `(${params.map((p) => flat(p.getText())).join(", ")}): ${declared(f.getReturnTypeNode(), () => f.getReturnType().getText(f))}`;
  const out = (kind: string, sig: string) => ({ kind, sig: flat(sig), inferred });
  if (TsNode.isFunctionDeclaration(d)) return out("function", fn(d));
  if (
    TsNode.isInterfaceDeclaration(d) ||
    TsNode.isTypeAliasDeclaration(d) ||
    TsNode.isEnumDeclaration(d)
  ) {
    const kind = TsNode.isInterfaceDeclaration(d)
      ? "interface"
      : TsNode.isEnumDeclaration(d)
        ? "enum"
        : "type";
    return out(kind, d.getText().replace(/^\s*export\s+(declare\s+)?/, ""));
  }
  if (TsNode.isClassDeclaration(d)) {
    const members = d
      .getMembers()
      .filter(
        (m) =>
          !m.getText().startsWith("#") &&
          !(
            "hasModifier" in m &&
            (m.hasModifier(SyntaxKind.PrivateKeyword) || m.hasModifier(SyntaxKind.ProtectedKeyword))
          ),
      )
      .map((m) =>
        TsNode.isMethodDeclaration(m)
          ? `${m.getName()}${fn(m)}`
          : TsNode.isConstructorDeclaration(m)
            ? `constructor(${m
                .getParameters()
                .map((p) => flat(p.getText()))
                .join(", ")})`
            : flat(
                m
                  .getText()
                  .replace(/=[\s\S]*$/, "")
                  .replace(/\{[\s\S]*$/, ""),
              ),
      );
    return out("class", members.join("; "));
  }
  if (TsNode.isVariableDeclaration(d)) {
    const init = d.getInitializer();
    if (
      !d.getTypeNode() &&
      init &&
      (TsNode.isArrowFunction(init) || TsNode.isFunctionExpression(init))
    )
      return out("function", fn(init));
    return out(
      "const",
      declared(d.getTypeNode(), () => d.getType().getText(d)),
    );
  }
  return out(d.getKindName(), "");
}

export const api: Layer = {
  id: "api",
  async extract({ root, config }) {
    const opts = config.layers.api ?? { packages: ["packages/*"] };
    const pkgs = (await packages(root, opts.packages)).filter((p) => Object.keys(p.entries).length);
    const project = tsProject(root, pkgs);
    // One node per declaration a package gives out, however many entries reach it.
    const byId = new Map<string, Node & { attrs: { entries: string[] } }>();
    for (const p of pkgs) {
      for (const [sub, path] of Object.entries(p.entries)) {
        const file = project.addSourceFileAtPathIfExists(`${root}/${path}`);
        if (!file) continue;
        const entry = sub === "." ? p.name : `${p.name}/${sub.replace(/^\.\//, "")}`;
        for (const [name, decls] of file.getExportedDeclarations()) {
          const d = decls[0];
          if (!d) continue;
          const from = relative(root, d.getSourceFile().getFilePath());
          const seen = byId.get(`${p.name}#${name}`);
          if (seen?.attrs.file === from) {
            seen.attrs.entries.push(entry);
            continue;
          }
          const { kind, sig, inferred } = signature(d);
          // Two declarations under one name (rare): the second is told apart by its entry.
          const id = seen ? `${entry}#${name}` : `${p.name}#${name}`;
          byId.set(id, {
            id,
            role: "export",
            parent: p.name,
            group: p.name,
            attrs: { entries: [entry], kind, sig, file: from, ...(inferred ? { inferred } : {}) },
          });
        }
      }
    }
    const nodes: Node[] = [...byId.values()];
    return { layer: "api", nodes, edges: [] };
  },
  render: (group) => page(group),
};

/** One package: its entries, each export with its kind and signature. Text, no diagram. */
function page(g: Graph): Record<string, string> {
  const pkg = g.nodes[0]?.group;
  if (!pkg) return {};
  const byEntry = new Map<string, Node[]>();
  for (const n of g.nodes) {
    const e = String(n.attrs?.file);
    byEntry.set(e, [...(byEntry.get(e) ?? []), n]);
  }
  const lines = [
    `# ${pkg}: interface`,
    "",
    `Exports: ${g.nodes.length}. Files: ${byEntry.size}.`,
    "",
  ];
  for (const [entry, list] of [...byEntry].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`## ${entry}`, "");
    for (const n of list) {
      const name = n.id.slice(n.id.indexOf("#") + 1);
      lines.push(`- **${name}** (${n.attrs?.kind}) \`${String(n.attrs?.sig).replace(/`/g, "'")}\``);
    }
    lines.push("");
  }
  return { [`${pkg.replace(/[/\\:]/g, "+")}.md`]: lines.join("\n") };
}
