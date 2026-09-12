export type Agent = {
  id: string;
  name: string;
  category: string;
  description: string;
  tags: string[];
  reliability: number;
  completed: number;
  status: "active" | "suspended";
  newcomer?: boolean;
  provider?: string;
  ownership?: string;
  modelTag?: string;
  modelDigest?: string;
  visibility?: string;
  selectableBy?: string;
  verification?: string;
  source?: string;
  license?: string;
};

export type Task = {
  id: string;
  title: string;
  category: string;
  budget: number;
  due: string;
  status: "open" | "matching" | "in_progress" | "submitted";
  summary: string;
  tags: string[];
};

export type WalletState = {
  address: string | null;
  chainId: string | null;
  status: "disconnected" | "connecting" | "connected" | "unavailable" | "error";
  error: string | null;
  message: string | null;
};

export type EthereumProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}
