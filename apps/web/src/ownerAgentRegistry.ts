export type OwnerAgentProvider = "ollama" | "https";
export type OwnerAgentPricing = "free" | "paid";
export type PlatformTestStatus = "not-required" | "pending" | "passed" | "failed";
export type OwnerAgentListingStatus = "owner-private" | "marketplace" | "pending-platform-test" | "rejected";

export type OwnerAgentRecord = {
  id: string;
  ownerWallet: string;
  displayName: string;
  category: string;
  description: string;
  tags: string[];
  provider: OwnerAgentProvider;
  modelTag: string;
  endpoint?: string;
  pricing: OwnerAgentPricing;
  pricePerTaskYd: number;
  platformTestStatus: PlatformTestStatus;
  listingStatus: OwnerAgentListingStatus;
  selectableBy: "owner-only" | "public-market";
  createdAt: string;
  updatedAt: string;
};

export type OwnerAgentDraft = Omit<
  OwnerAgentRecord,
  "id" | "platformTestStatus" | "listingStatus" | "selectableBy" | "createdAt" | "updatedAt"
>;

const DATABASE_NAME = "agent-market-owner-registry";
const DATABASE_VERSION = 1;
const STORE_NAME = "agents";

export function determineAgentAdmission(input: Pick<OwnerAgentDraft, "provider" | "pricing"> & { platformTestStatus?: PlatformTestStatus }) {
  if (input.provider === "ollama") {
    return {
      platformTestStatus: "not-required" as const,
      listingStatus: "owner-private" as const,
      selectableBy: "owner-only" as const,
      marketVisible: false,
      reasonCode: "LOCAL_OWNER_ONLY",
    };
  }
  if (input.pricing === "free") {
    return {
      platformTestStatus: "not-required" as const,
      listingStatus: "marketplace" as const,
      selectableBy: "public-market" as const,
      marketVisible: true,
      reasonCode: "FREE_DIRECT_LISTING",
    };
  }
  if (input.platformTestStatus === "passed") {
    return {
      platformTestStatus: "passed" as const,
      listingStatus: "marketplace" as const,
      selectableBy: "public-market" as const,
      marketVisible: true,
      reasonCode: "PAID_PLATFORM_TEST_PASSED",
    };
  }
  if (input.platformTestStatus === "failed") {
    return {
      platformTestStatus: "failed" as const,
      listingStatus: "rejected" as const,
      selectableBy: "owner-only" as const,
      marketVisible: false,
      reasonCode: "PAID_PLATFORM_TEST_FAILED",
    };
  }
  return {
    platformTestStatus: "pending" as const,
    listingStatus: "pending-platform-test" as const,
    selectableBy: "owner-only" as const,
    marketVisible: false,
    reasonCode: "PAID_PLATFORM_TEST_REQUIRED",
  };
}

export function createOwnerAgentRecord(draft: OwnerAgentDraft, now = new Date()): OwnerAgentRecord {
  const ownerWallet = normalizeWallet(draft.ownerWallet);
  const tags = [...new Set(draft.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 32);
  const admission = determineAgentAdmission(draft);
  const timestamp = now.toISOString();
  return {
    ...draft,
    id: createId(),
    ownerWallet,
    displayName: draft.displayName.trim(),
    category: draft.category.trim(),
    description: draft.description.trim(),
    tags,
    modelTag: draft.modelTag.trim(),
    ...(draft.provider === "https" && draft.endpoint?.trim() ? { endpoint: draft.endpoint.trim() } : {}),
    pricePerTaskYd: draft.pricing === "free" ? 0 : Math.max(0, draft.pricePerTaskYd),
    platformTestStatus: admission.platformTestStatus,
    listingStatus: admission.listingStatus,
    selectableBy: admission.selectableBy,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function isMarketVisible(record: OwnerAgentRecord): boolean {
  return determineAgentAdmission(record).marketVisible;
}

export async function listOwnerAgents(ownerWallet: string): Promise<OwnerAgentRecord[]> {
  if (typeof indexedDB === "undefined") return [];
  const database = await openDatabase();
  const normalizedWallet = normalizeWallet(ownerWallet);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).index("ownerWallet").getAll(normalizedWallet);
    request.onsuccess = () => resolve((request.result as OwnerAgentRecord[]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    request.onerror = () => reject(request.error ?? new Error("Owner Agent registry read failed"));
  });
}

export async function saveOwnerAgent(record: OwnerAgentRecord): Promise<void> {
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB is unavailable");
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Owner Agent registry write failed"));
  });
}

export async function removeOwnerAgent(ownerWallet: string, id: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const database = await openDatabase();
  const existing = await getAgent(database, id);
  if (existing === undefined || existing.ownerWallet !== normalizeWallet(ownerWallet)) {
    throw new Error("Owner Agent record is not owned by the connected wallet");
  }
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Owner Agent registry delete failed"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(STORE_NAME)
        ? request.transaction!.objectStore(STORE_NAME)
        : database.createObjectStore(STORE_NAME, { keyPath: "id" });
      if (!store.indexNames.contains("ownerWallet")) store.createIndex("ownerWallet", "ownerWallet", { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Owner Agent registry open failed"));
  });
}

function getAgent(database: IDBDatabase, id: string): Promise<OwnerAgentRecord | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result as OwnerAgentRecord | undefined);
    request.onerror = () => reject(request.error ?? new Error("Owner Agent registry lookup failed"));
  });
}

function normalizeWallet(wallet: string): string {
  const normalized = wallet.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error("A valid wallet address is required");
  return normalized;
}

function createId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `owner-agent-${random}`;
}
