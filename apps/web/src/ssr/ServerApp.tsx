import { FullChainEvidence } from "../evidence/FullChainEvidence";
import { routeForPath } from "./routeDefinitions";

export function ServerApp({ pathname }: { pathname: string }) {
  const route = routeForPath(pathname);
  const title = route?.title ?? "Page not found";
  const summary = route?.summary
    ?? "This route is not part of the Agent Market delivery surface.";

  return (
    <main className="edge-route-shell">
      <header>
        <a href="/" aria-label="Agent Market home">AGENT MARKET</a>
        <nav aria-label="Primary navigation">
          <a href="/agents">Agents</a>
          <a href="/tasks">Tasks</a>
          <a href="/staking">Staking</a>
          <a href="/evidence/">Evidence</a>
        </nav>
      </header>
      <section aria-labelledby="edge-route-title">
        <p>{route?.area ?? "404"} / EDGE ROUTE</p>
        <h1 id="edge-route-title">{title}</h1>
        <p>{summary}</p>
        <dl>
          <div><dt>Rendering</dt><dd>Cloudflare Edge SSR</dd></div>
          <div><dt>Chain</dt><dd>Ethereum Sepolia</dd></div>
          <div><dt>Evidence</dt><dd>Requirement to verification trace</dd></div>
        </dl>
      </section>
      {pathname === "/evidence" ? <FullChainEvidence /> : null}
    </main>
  );
}
