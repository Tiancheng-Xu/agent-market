import type { Agent } from "./types";

const DATABASE_NAME = "agent-market-owner";
const STORE_NAME = "agents";
const DATABASE_VERSION = 1;

export type OwnerAgentRecord = Agent & {
  ownerWallet: string;
  createdAt: string;
};

export async function listOwnerAgents(ownerWallet: string | null): Promise<OwnerAgentRecord[]> {
  if (!ownerWallet || typeof indexedDB === "undefined") return [];
  const records = await request<OwnerAgentRecord[]>("readonly", (store) => store.getAll());
  return records.filter((record) => record.ownerWallet === ownerWallet.toLowerCase());
}

export async function saveOwnerAgent(record: OwnerAgentRecord): Promise<void> {
  if (typeof indexedDB === "undefined") throw new Error("OWNER_AGENT_STORAGE_UNAVAILABLE");
  await request("readwrite", (store) => store.put({ ...record, ownerWallet: record.ownerWallet.toLowerCase() }));
}

let activeDatabase: IDBDatabase | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (activeDatabase) return Promise.resolve(activeDatabase);
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains(STORE_NAME)) {
        opening.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    opening.onerror = () => reject(opening.error ?? new Error("OWNER_AGENT_STORAGE_OPEN_FAILED"));
    opening.onsuccess = () => {
      activeDatabase = opening.result;
      resolve(opening.result);
    };
  });
}

async function request<T = IDBValidKey>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  const operation = run(database.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error ?? new Error("OWNER_AGENT_STORAGE_WRITE_FAILED"));
  });
}
