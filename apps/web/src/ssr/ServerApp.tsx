import { FullChainEvidence } from "../evidence/FullChainEvidence";
import phase2Evidence from "../evidence/phase2-evidence.generated.json";
import { routeForPath } from "./routeDefinitions";
import { OpsPage } from "../pages/ControlPages";

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
          <a href="/office">Office</a>
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
      {pathname.replace(/\/+$/, "") === "/ops" ? <OpsPage walletAddress={null} /> : null}
      {pathname.replace(/\/+$/, "") === "/evidence" ? <>
        <p data-evidence-boundary="current">{phase2Evidence.truthBoundary.en}</p>
        <FullChainEvidence />
      </> : null}
    </main>
  );
}
