/** Shared by the imports page and the viewer: no imports, so the viewer bundle stays small. */

/** `name` → `name@version` where the lock has one, sorted. */
export const withVersions = (npm: readonly string[], versions: unknown): string[] => {
  const at = new Map(
    (Array.isArray(versions) ? (versions as string[]) : []).map((v) => {
      const i = v.lastIndexOf("@");
      return [v.slice(0, i), v] as const;
    }),
  );
  return npm.map((n) => at.get(n) ?? n).sort();
};
