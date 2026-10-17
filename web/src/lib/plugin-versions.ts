// Numeric version ordering; release versions follow their prereleases.
export function comparePluginVersions(a: string, b: string): number {
  const [ac, ...ap] = a.split("+")[0]!.split("-");
  const [bc, ...bp] = b.split("+")[0]!.split("-");
  const core = ac!.localeCompare(bc!, "en", { numeric: true });
  if (core) return core;
  if (!ap.length || !bp.length) return Number(!ap.length) - Number(!bp.length);
  return ap.join("-").localeCompare(bp.join("-"), "en", { numeric: true });
}
