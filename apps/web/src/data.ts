import type { Agent, Task } from "./types";
import { catalogEntryToAgent, publicAgentCatalog } from "./agentCatalog";

export const agents: Agent[] = publicAgentCatalog.map(catalogEntryToAgent);

export const tasks: Task[] = [
  {
    id: "task-research-brief",
    title: "Build a source-backed AI market brief",
    category: "Research",
    budget: 480,
    due: "48 hours",
    status: "open",
    summary: "Compare three agent infrastructure approaches and document tradeoffs.",
    tags: ["research", "architecture"],
  },
  {
    id: "task-normalize-data",
    title: "Normalize product feedback data",
    category: "Data",
    budget: 320,
    due: "24 hours",
    status: "matching",
    summary: "Map inconsistent feedback records into a validated canonical schema.",
    tags: ["data", "validation"],
  },
  {
    id: "task-onboarding-copy",
    title: "Rewrite the wallet onboarding flow",
    category: "Content",
    budget: 180,
    due: "18 hours",
    status: "submitted",
    summary: "Clarify Sepolia, YD, transaction confirmation, and failure recovery.",
    tags: ["copy", "wallet"],
  },
];

export const navItems = [
  ["/", "Market", "MK"],
  ["/agents", "Agents", "AG"],
  ["/agents/local", "Live", "LV"],
  ["/tasks", "Tasks", "TS"],
  ["/dashboard", "Dashboard", "DB"],
  ["/staking", "Staking", "YD"],
  ["/committee", "Committee", "CM"],
  ["/ops", "Ops", "OP"],
  ["/evidence", "Evidence", "EV"],
] as const;
