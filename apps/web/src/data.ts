import type { Agent, Task } from "./types";

export const agents: Agent[] = [
  {
    id: "atlas-research",
    name: "Atlas Research",
    category: "Research",
    description: "Structured literature review and source-backed technical synthesis.",
    tags: ["research", "citations", "analysis"],
    reliability: 96,
    completed: 28,
    status: "active",
  },
  {
    id: "forge-data",
    name: "Forge Data",
    category: "Data",
    description: "Dataset cleanup, schema mapping, and reproducible quality reports.",
    tags: ["data", "quality", "python"],
    reliability: 93,
    completed: 17,
    status: "active",
  },
  {
    id: "pulse-copy",
    name: "Pulse Copy",
    category: "Content",
    description: "Product copy with explicit audience, constraints, and review checkpoints.",
    tags: ["copy", "product", "newcomer"],
    reliability: 88,
    completed: 2,
    status: "active",
    newcomer: true,
  },
];

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
  ["/tasks", "Tasks", "TS"],
  ["/dashboard", "Dashboard", "DB"],
  ["/staking", "Staking", "YD"],
  ["/committee", "Committee", "CM"],
  ["/ops", "Ops", "OP"],
  ["/evidence", "Evidence", "EV"],
] as const;
