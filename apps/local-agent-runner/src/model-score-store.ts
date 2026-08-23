import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ModelScoreEvent = {
  eventId: string;
  taskId: string;
  nodeId: string;
  agentId: string;
  score: number;
  verdict: string;
  observedAt: string;
};

export type LearningMemory = {
  memoryRecordId: string;
  taskId: string;
  summary: string;
  observedAt: string;
};

export type ModelScoreStore = {
  scoreFor(agentId: string): number | undefined;
  firstSeenAt(agentId: string): string | undefined;
  recordScore(event: ModelScoreEvent): void;
  writeLearning(memory: LearningMemory): void;
};

type StoreDocument = {
  schemaVersion: 1;
  scores: Record<string, { qualityScore: number; completedTasks: number; firstSeenAt: string }>;
  events: ModelScoreEvent[];
  learning: LearningMemory[];
};

export function createFileModelScoreStore(path: string): ModelScoreStore {
  let document = readDocument(path);
  const persist = () => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  };
  return {
    scoreFor: (agentId) => document.scores[agentId]?.qualityScore,
    firstSeenAt: (agentId) => document.scores[agentId]?.firstSeenAt,
    recordScore(event) {
      if (document.events.some((item) => item.eventId === event.eventId)) return;
      const current = document.scores[event.agentId] ?? { qualityScore: 0, completedTasks: 0, firstSeenAt: event.observedAt };
      const bounded = Math.max(0, Math.min(1, event.score));
      document = {
        ...document,
        scores: {
          ...document.scores,
          [event.agentId]: {
            ...current,
            qualityScore: Number((current.qualityScore * 0.8 + bounded * 0.2).toFixed(4)),
            completedTasks: current.completedTasks + 1,
          },
        },
        events: [...document.events, event].slice(-5_000),
      };
      persist();
    },
    writeLearning(memory) {
      if (document.learning.some((item) => item.memoryRecordId === memory.memoryRecordId)) return;
      document = { ...document, learning: [...document.learning, memory].slice(-2_000) };
      persist();
    },
  };
}

export function createMemoryModelScoreStore(): ModelScoreStore {
  const scores = new Map<string, { score: number; firstSeenAt: string }>();
  const events = new Set<string>();
  const memories = new Set<string>();
  return {
    scoreFor: (agentId) => scores.get(agentId)?.score,
    firstSeenAt: (agentId) => scores.get(agentId)?.firstSeenAt,
    recordScore(event) {
      if (events.has(event.eventId)) return;
      events.add(event.eventId);
      const current = scores.get(event.agentId) ?? { score: 0, firstSeenAt: event.observedAt };
      scores.set(event.agentId, { ...current, score: current.score * 0.8 + Math.max(0, Math.min(1, event.score)) * 0.2 });
    },
    writeLearning(memory) { memories.add(memory.memoryRecordId); },
  };
}

function readDocument(path: string): StoreDocument {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as StoreDocument;
    if (parsed.schemaVersion === 1) return parsed;
  } catch {
    // Missing or invalid local state starts a new private ledger.
  }
  return { schemaVersion: 1, scores: {}, events: [], learning: [] };
}
