import { MemoryAuthStore, PostgresAuthStore } from "./auth-store";
import { WalletAuthService } from "./session";

let testService: WalletAuthService | undefined;
let developmentService: WalletAuthService | undefined;

export function setAuthServiceForTests(service: WalletAuthService | undefined): void {
  testService = service;
}

export function resetAuthRuntimeForTests(): void {
  testService = undefined;
  developmentService = undefined;
}

export function getAuthOrigin(): URL {
  const value = process.env.AUTH_ORIGIN?.trim();
  if (!value) throw new Error("AUTH_ORIGIN_NOT_CONFIGURED");
  const origin = new URL(value);
  if (origin.protocol !== "https:" || origin.origin !== value.replace(/\/$/u, "")) {
    throw new Error("AUTH_ORIGIN_INVALID");
  }
  return origin;
}

export function getAuthService(): WalletAuthService {
  if (testService) return testService;
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!developmentService && databaseUrl) {
    developmentService = new WalletAuthService(PostgresAuthStore.connect(databaseUrl));
  }
  if (!developmentService && process.env.NODE_ENV === "production") throw new Error("AUTH_STORE_NOT_CONFIGURED");
  developmentService ??= new WalletAuthService(new MemoryAuthStore());
  return developmentService;
}
