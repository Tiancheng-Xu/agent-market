// Share the same import promises with React.lazy and the hydration handoff.
let local: ReturnType<typeof importLocal> | undefined;
let order: ReturnType<typeof importOrder> | undefined;
const importLocal = () => import("./pages/LocalAgentsPage");
const importOrder = () => import("./pages/OrderDetailRoute");
export const loadLocalRoute = () => local ??= importLocal();
export const loadOrderRoute = () => order ??= importOrder();

export async function prepareRoute(pathname: string): Promise<void> {
  const route = pathname.replace(/\/+$/, "");
  if (route === "/agents/local") await loadLocalRoute();
  else if (/^\/tasks\/[^/]+$/.test(route) && route !== "/tasks/new") await loadOrderRoute();
}
