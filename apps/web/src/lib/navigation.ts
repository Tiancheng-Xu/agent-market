/** Select the most specific section, keeping detail routes under their parent. */
export function activeNavigationPath(pathname: string, paths: readonly string[]): string | undefined {
  const current = pathname.replace(/\/+$/u, "").toLowerCase() || "/";
  let selected: string | undefined;
  for (const path of paths) {
    const candidate = path.toLowerCase();
    if ((current === candidate || (candidate !== "/" && current.startsWith(`${candidate}/`)))
        && (selected === undefined || path.length > selected.length)) selected = path;
  }
  return selected;
}
