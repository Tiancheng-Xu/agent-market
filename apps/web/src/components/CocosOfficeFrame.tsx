import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toPublicOfficeSnapshot } from "@agent-market/shared-contracts";

import type { OfficeTaskDesk, OfficeTaskStatus } from "../officeModel";
import { parseOfficeCocosMessage, postOfficeSnapshot } from "../officeCocosBridge";
import { translateLocalizedText, useLanguage } from "../i18n/LanguageProvider";

type OfficeFrameStatus = "loading" | "ready" | "degraded" | "unavailable";

export function officeFrameStatusFromRuntimeState(value: string | undefined): Extract<OfficeFrameStatus, "ready" | "degraded"> | undefined {
  return value === "ready" || value === "degraded" ? value : undefined;
}

export function CocosOfficeFrame({
  desks,
  statusFilter,
  viewerWallet,
  selectedTaskId,
  onSelectTask,
  fallback,
}: {
  desks: OfficeTaskDesk[];
  statusFilter: "all" | OfficeTaskStatus;
  viewerWallet: string | null;
  selectedTaskId: string;
  onSelectTask: (taskId: string) => void;
  fallback: ReactNode;
}) {
  const { locale } = useLanguage();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<OfficeFrameStatus>("loading");
  const expectedOrigin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const snapshot = useMemo(() => toPublicOfficeSnapshot({
    desks,
    statusFilter,
    viewerWallet,
    locale,
  }), [desks, locale, statusFilter, viewerWallet]);

  function syncFrameStatus(frame: Window): void {
    try {
      const runtimeState = officeFrameStatusFromRuntimeState(frame.document.documentElement.dataset.officeRuntime);
      if (!runtimeState) return;
      setStatus(runtimeState);
      // Delayed onLoad probes can outlive the filter/locale they captured.
      // Only observe readiness here; current effects/messages send snapshots.
    } catch {
      // postMessage remains authoritative if the frame ever moves cross-origin.
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => setStatus((current) => current === "ready" || current === "degraded" ? current : "unavailable"), 20000);
    const onMessage = (event: MessageEvent<unknown>) => {
      const frame = frameRef.current?.contentWindow;
      if (!frame) return;
      const message = parseOfficeCocosMessage(event, { expectedOrigin, expectedSource: frame });
      if (!message) return;
      if (message.type === "agent-market.office.ready.v2") {
        setStatus("ready");
        postOfficeSnapshot(frame, expectedOrigin, snapshot);
      } else if (message.type === "agent-market.office.degraded.v2") {
        setStatus("degraded");
        postOfficeSnapshot(frame, expectedOrigin, snapshot);
      } else {
        onSelectTask(message.taskId);
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
  }, [expectedOrigin, onSelectTask, snapshot]);

  useEffect(() => {
    const frame = frameRef.current?.contentWindow;
    if ((status === "ready" || status === "degraded") && frame) postOfficeSnapshot(frame, expectedOrigin, snapshot);
  }, [expectedOrigin, snapshot, status, selectedTaskId]);

  return <div className={`cocos-office-host cocos-office-${status}`}>
    <iframe
      ref={frameRef}
      className="cocos-office-frame"
      src="/office-cocos/index.html"
      title="Cocos virtual Agent office"
      sandbox="allow-scripts allow-same-origin"
      onLoad={() => {
        const frame = frameRef.current?.contentWindow;
        if (!frame) return;
        postOfficeSnapshot(frame, expectedOrigin, snapshot);
        syncFrameStatus(frame);
        window.setTimeout(() => syncFrameStatus(frame), 250);
        window.setTimeout(() => syncFrameStatus(frame), 1000);
      }}
      onError={() => setStatus("unavailable")}
    />
    {status === "degraded" ? <p className="cocos-office-status inline-state" role="status">{locale === "zh-CN"
      ? "Cocos 素材加载失败，当前展示真实降级画布。"
      : "Cocos assets failed to load. The real degraded canvas remains visible."}</p> : null}
    {status === "loading" || status === "unavailable" ? <div className="cocos-office-fallback">
      <p className="inline-state">{status === "loading"
        ? translateLocalizedText(locale, "Cocos office is loading. The verified Web office remains available.")
        : translateLocalizedText(locale, "Cocos office is unavailable. Showing the Web office without faking runtime success.")}</p>
      {fallback}
    </div> : null}
  </div>;
}
