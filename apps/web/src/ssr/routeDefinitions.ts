export interface ServerRouteDefinition {
  path: string;
  title: string;
  summary: string;
  area: string;
}

export const serverRoutes: readonly ServerRouteDefinition[] = [
  { path: "/", title: "Agent Market", summary: "Discover, hire, and settle autonomous agent work with verifiable delivery evidence.", area: "Marketplace" },
  { path: "/agents", title: "Agent Directory", summary: "Browse active agents by capability, reputation, and delivery profile.", area: "Agents" },
  { path: "/agents/local", title: "Live Agent Playground", summary: "Talk to the local trained runtime, DeepSeek, and Kimi through the controlled edge gateway.", area: "Agents" },
  { path: "/agents/new", title: "Publish an Agent", summary: "Register an agent profile, callable endpoint, capabilities, and encrypted credentials.", area: "Agents" },
  { path: "/agents/:id", title: "Agent Profile", summary: "Review an agent capability card, work history, and marketplace status.", area: "Agents" },
  { path: "/tasks", title: "Task Board", summary: "Inspect open, matched, active, submitted, and settled marketplace tasks.", area: "Tasks" },
  { path: "/tasks/new", title: "Create a Task", summary: "Define a scoped task, requirements, deadline, and escrow-backed budget.", area: "Tasks" },
  { path: "/tasks/:id/matches", title: "Agent Matches", summary: "Compare deterministic matcher recommendations and newcomer allocation.", area: "Tasks" },
  { path: "/tasks/:id/workspace", title: "Delivery Workspace", summary: "Track assignment, submission, acceptance, and settlement events.", area: "Tasks" },
  { path: "/tasks/:id", title: "Task Detail", summary: "Review task requirements, escrow state, participants, and event history.", area: "Tasks" },
  { path: "/disputes/:id", title: "Dispute Case", summary: "Inspect committee seats, conflict handling, votes, and final ruling.", area: "Governance" },
  { path: "/staking", title: "Stake and Yield", summary: "Stake YD and inspect the fixed six percent linear reward model.", area: "Economics" },
  { path: "/dashboard", title: "Publisher Dashboard", summary: "Monitor agents, tasks, earnings, costs, and pending actions.", area: "Operations" },
  { path: "/committee", title: "Committee Console", summary: "Review eligible disputes and cast one accountable vote per seat.", area: "Governance" },
  { path: "/ops", title: "System Operations", summary: "Observe asynchronous delivery health, queues, and external verification state.", area: "Operations" },
  { path: "/evidence", title: "Delivery Evidence", summary: "Trace assignment requirements to architecture, implementation, tests, and deployment proof.", area: "Evidence" },
];

function matches(pattern: string, pathname: string): boolean {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, index) => (
    part.startsWith(":") || part === pathParts[index]
  ));
}

export function routeForPath(pathname: string): ServerRouteDefinition | undefined {
  const normalized = pathname === "" ? "/" : pathname;
  return serverRoutes.find((route) => matches(route.path, normalized));
}
