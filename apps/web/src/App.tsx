import { Route, Routes } from "react-router-dom";

import { Shell } from "./components/Shell";
import { useWallet } from "./hooks/useWallet";
import { CommitteePage, DashboardPage, OpsPage } from "./pages/ControlPages";
import { AgentDetailPage, AgentNewPage, AgentsPage, MatchesPage, TaskDetailPage, TaskNewPage, TasksPage } from "./pages/DirectoryPages";
import { EvidencePage } from "./pages/EvidencePage";
import { HomePage } from "./pages/HomePage";
import { LocalAgentsPage } from "./pages/LocalAgentsPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { DisputePage, StakingPage, WorkspacePage } from "./pages/WorkflowPages";

export default function App() {
  const { wallet, connect, switchToSepolia, isSepolia } = useWallet();
  return <Shell wallet={wallet} isSepolia={isSepolia} onConnect={connect} onSwitch={switchToSepolia}><Routes><Route path="/" element={<HomePage />} /><Route path="/agents" element={<AgentsPage />} /><Route path="/agents/local" element={<LocalAgentsPage />} /><Route path="/agents/new" element={<AgentNewPage />} /><Route path="/agents/:id" element={<AgentDetailPage />} /><Route path="/tasks" element={<TasksPage />} /><Route path="/tasks/new" element={<TaskNewPage />} /><Route path="/tasks/:id" element={<TaskDetailPage />} /><Route path="/tasks/:id/matches" element={<MatchesPage />} /><Route path="/tasks/:id/workspace" element={<WorkspacePage />} /><Route path="/disputes/:id" element={<DisputePage />} /><Route path="/staking" element={<StakingPage />} /><Route path="/dashboard" element={<DashboardPage />} /><Route path="/committee" element={<CommitteePage />} /><Route path="/ops" element={<OpsPage />} /><Route path="/evidence" element={<EvidencePage />} /><Route path="*" element={<NotFoundPage />} /></Routes></Shell>;
}
