import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toPublicOfficeSnapshot } from "@agent-market/shared-contracts";

import type { OfficeTaskDesk, OfficeTaskStatus } from "../officeModel";
import { parseOfficeCocosMessage, postOfficeSnapshot } from "../officeCocosBridge";
import { translateLocalizedText, useLanguage } from "../i18n/LanguageProvider";

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
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const expectedOrigin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const snapshot = useMemo(() => toPublicOfficeSnapshot({
    desks,
    statusFilter,
    viewerWallet,
    locale,
  }), [desks, locale, statusFilter, viewerWallet]);

  useEffect(() => {
    const timer = window.setTimeout(() => setStatus((current) => current === "ready" ? current : "unavailable"), 20000);
    const onMessage = (event: MessageEvent<unknown>) => {
      const frame = frameRef.current?.contentWindow;
      if (!frame) return;
      const message = parseOfficeCocosMessage(event, { expectedOrigin, expectedSource: frame });
      if (!message) return;
      if (message.type === "agent-market.office.ready.v1") {
        setStatus("ready");
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
    if (status === "ready" && frame) postOfficeSnapshot(frame, expectedOrigin, snapshot);
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
        if (frame) postOfficeSnapshot(frame, expectedOrigin, snapshot);
      }}
      onError={() => setStatus("unavailable")}
    />
    {status !== "ready" ? <div className="cocos-office-fallback">
      <p className="inline-state">{status === "loading"
        ? translateLocalizedText(locale, "Cocos office is loading. The verified Web office remains available.")
        : translateLocalizedText(locale, "Cocos office is unavailable. Showing the Web office without faking runtime success.")}</p>
      {fallback}
    </div> : null}
  </div>;
}
