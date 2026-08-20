export const SECONDS_PER_YEAR = 31_536_000;

export function calculateLinearYield(principal: number, elapsedSeconds: number): number {
  if (!Number.isFinite(principal) || !Number.isFinite(elapsedSeconds) || principal < 0 || elapsedSeconds < 0) {
    throw new Error("principal and elapsedSeconds must be finite non-negative numbers");
  }
  return Math.floor((principal * 6 * elapsedSeconds) / (100 * SECONDS_PER_YEAR));
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}
