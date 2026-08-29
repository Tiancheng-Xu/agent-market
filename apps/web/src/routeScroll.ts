export function resetRouteScroll(
  documentRoot: Document,
  viewport: Pick<Window, "scrollTo">,
): void {
  const previousScrollBehavior = documentRoot.documentElement.style.scrollBehavior;
  documentRoot.documentElement.style.scrollBehavior = "auto";
  viewport.scrollTo(0, 0);

  const scrollContainers = [
    documentRoot.scrollingElement,
    ...documentRoot.querySelectorAll<HTMLElement>("main, .app-column, [data-route-scroll]"),
  ];

  for (const container of scrollContainers) {
    if (!container) continue;
    container.scrollTop = 0;
    container.scrollLeft = 0;
  }

  documentRoot.documentElement.style.scrollBehavior = previousScrollBehavior;
}
