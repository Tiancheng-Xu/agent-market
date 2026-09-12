import { lazy, Suspense, useLayoutEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";

import { Shell } from "./components/Shell";
import { useWallet } from "./hooks/useWallet";
import { CommitteePage, DashboardPage, OpsPage } from "./pages/ControlPages";
import { ManagedAgentsPage } from "./pages/ManagedAgentsPage";
import { ExplainableMatchesPage } from "./pages/ExplainableMatchesPage";
import { AgentDetailPage, AgentNewPage, TaskNewPage, TasksPage } from "./pages/DirectoryPages";
import { EvidencePage } from "./pages/EvidencePage";
import { HomePage } from "./pages/HomePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { DisputePage, StakingPage, WorkspacePage } from "./pages/WorkflowPages";
import { resetRouteScroll } from "./routeScroll";
import { loadLocalRoute, loadOrderRoute } from "./routeModules";
import { RouteBoundary } from "./components/RouteBoundary";

const LocalAgentsPage = lazy(() => loadLocalRoute().then((module) => ({
  default: module.LocalAgentsPage,
})));
const OrderDetailRoute = lazy(loadOrderRoute);

function RouteFallback() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading route"
      className="panel"
      data-route-fallback="true"
      style={{ minHeight: "680px" }}
    >
      <span className="eyebrow">LOADING MODULE</span>
      <p className="muted">Preparing this workspace without shifting the surrounding layout.</p>
    </div>
  );
}

function RouteScrollReset() {
  const { pathname } = useLocation();

  useLayoutEffect(() => {
    const reset = () => resetRouteScroll(document, window);
    window.history.scrollRestoration = "manual";
    reset();
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      reset();
      secondFrame = window.requestAnimationFrame(reset);
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [pathname]);

  return null;
}

export default function App() {
  const { wallet, connect, switchToSepolia, isSepolia } = useWallet();
  return <Shell wallet={wallet} isSepolia={isSepolia} onConnect={connect} onSwitch={switchToSepolia}><RouteScrollReset /><RouteBoundary><Routes><Route path="/" element={<HomePage />} /><Route path="/agents" element={<ManagedAgentsPage walletAddress={wallet.address} />} /><Route path="/agents/local" element={<Suspense fallback={<RouteFallback />}><LocalAgentsPage walletAddress={wallet.address} /></Suspense>} /><Route path="/agents/new" element={<AgentNewPage walletAddress={wallet.address} />} /><Route path="/agents/:id" element={<AgentDetailPage />} /><Route path="/tasks" element={<TasksPage />} /><Route path="/tasks/new" element={<TaskNewPage walletAddress={wallet.address} />} /><Route path="/tasks/:id" element={<Suspense fallback={<RouteFallback />}><OrderDetailRoute walletAddress={wallet.address} /></Suspense>} /><Route path="/tasks/:id/matches" element={<ExplainableMatchesPage />} /><Route path="/tasks/:id/workspace" element={<WorkspacePage walletAddress={wallet.address} />} /><Route path="/office" element={<WorkspacePage walletAddress={wallet.address} />} /><Route path="/disputes/:id" element={<DisputePage />} /><Route path="/staking" element={<StakingPage walletAddress={wallet.address} />} /><Route path="/dashboard" element={<DashboardPage />} /><Route path="/committee" element={<CommitteePage walletAddress={wallet.address} />} /><Route path="/ops" element={<OpsPage walletAddress={wallet.address} />} /><Route path="/evidence" element={<EvidencePage />} /><Route path="*" element={<NotFoundPage />} /></Routes></RouteBoundary></Shell>;
}
