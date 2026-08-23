export type PerformanceMode = "full" | "degraded" | "offline";

export type PerformanceProfile = {
  mode: PerformanceMode;
  reasonCodes: string[];
};

type NetworkInformation = EventTarget & {
  effectiveType?: string;
  saveData?: boolean;
};

type CapabilityNavigator = Navigator & {
  connection?: NetworkInformation;
  deviceMemory?: number;
};

export function detectPerformanceProfile(navigatorValue: CapabilityNavigator = navigator): PerformanceProfile {
  if (!navigatorValue.onLine) return { mode: "offline", reasonCodes: ["NETWORK_OFFLINE"] };
  const reasons: string[] = [];
  if (navigatorValue.connection?.saveData) reasons.push("SAVE_DATA");
  if (["slow-2g", "2g"].includes(navigatorValue.connection?.effectiveType ?? "")) reasons.push("SLOW_NETWORK");
  if ((navigatorValue.deviceMemory ?? 8) <= 2) reasons.push("LOW_MEMORY");
  if ((navigatorValue.hardwareConcurrency ?? 8) <= 2) reasons.push("LOW_CPU");
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) reasons.push("REDUCED_MOTION");
  return { mode: reasons.length > 0 ? "degraded" : "full", reasonCodes: reasons };
}

export function applyPerformanceProfile(profile: PerformanceProfile): void {
  document.documentElement.dataset.performanceMode = profile.mode;
  globalThis.dispatchEvent(new CustomEvent("agent-market:performance-mode", { detail: profile }));
}

export function watchPerformanceProfile(onChange: (profile: PerformanceProfile) => void): () => void {
  const nav = navigator as CapabilityNavigator;
  const update = () => onChange(detectPerformanceProfile(nav));
  globalThis.addEventListener("online", update);
  globalThis.addEventListener("offline", update);
  nav.connection?.addEventListener("change", update);
  update();
  return () => {
    globalThis.removeEventListener("online", update);
    globalThis.removeEventListener("offline", update);
    nav.connection?.removeEventListener("change", update);
  };
}
