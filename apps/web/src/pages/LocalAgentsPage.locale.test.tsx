import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queenPlanningStatusLabel, type QueenPlanningStatus } from "../lib/queenPlanningClient";
import { LocalAgentsPage, localQueenCopy } from "./LocalAgentsPage";

// Static copy coverage, not a browser/viewport Gate or authenticated workflow run.
// SSR does not run LanguageProvider's storage effect, so select this page's locale explicitly.
const language = vi.hoisted(() => ({ locale: "zh-CN" as "en" | "zh-CN" }));
vi.mock("../i18n/LanguageProvider", async importOriginal => {
  const actual = await importOriginal<typeof import("../i18n/LanguageProvider")>();
  return { ...actual, useLanguage: () => ({ locale: language.locale, setLocale() {},
    t: (key: string) => actual.translateLocalizedText(language.locale, key) }) };
});
afterEach(() => { language.locale = "zh-CN"; });

const omissions = [
  ["Chat and orchestration are disabled. Persisted Queen planning uses the separate authenticated TE gateway; Runtime health does not prove its worker readiness.",
    "聊天与编排暂不可用。已保存任务的 Queen 规划使用独立的认证 TE 网关；Runtime 健康检查不能证明规划 Worker 已就绪。"],
  ["Connect a wallet using the existing wallet control, then explicitly sign in.", "请先通过页面的钱包入口连接钱包，再主动签名登录。"],
  ["Local demonstration only. Not a real task, persisted plan, assignment or execution.", "仅供本地演示，不代表真实任务、持久化计划、任务分配或执行结果。"],
  ["Local demonstration only. No persisted task loaded.", "仅供本地演示，尚未加载持久化任务。"],
] as const;

describe("Local page Chinese business copy", () => {
  it("renders all four final-visual omissions in Chinese without changing technical identifiers or action gates", () => {
    const markup = renderToStaticMarkup(<LocalAgentsPage />);
    for (const [english, chinese] of omissions) {
      expect(markup).toContain(chinese);
      expect(markup).not.toContain(english);
    }
    expect(markup).toContain("RUNTIME_OFFLINE");
    expect(markup).toContain("本地演示");
    expect(markup).toContain("仅查看本地演示");
    expect(markup).toContain("连接钱包不等于签名登录");
    expect(markup).toMatch(/<button[^>]+disabled=""[^>]*>确认此版本计划（不执行）<\/button>/u);
    expect(markup).not.toContain("Start workflow");
    expect(markup).toContain('class="queen-react-flow"');
  });

  it("keeps the English version unchanged", () => {
    language.locale = "en";
    const markup = renderToStaticMarkup(<LocalAgentsPage />);
    for (const [english, chinese] of omissions) {
      expect(markup).toContain(english);
      expect(markup).not.toContain(chinese);
    }
    expect(markup).toContain("Local demo only");
  });

  it.each([
    ["requestId: test-task-id; queued; duplicate: false. Queued only, not a generated graph or execution.", "仅表示已排队，不代表任务图已生成或任务已执行。", "requestId: test-task-id; queued; duplicate: false."],
    ["approvalId: test-approval-id; queued; duplicate: true. Approval recorded, not execution completed.", "仅表示审批已记录，不代表执行完成。", "approvalId: test-approval-id; queued; duplicate: true."],
  ])("renders translated asynchronous feedback while preserving its transport values: %s", (message, translated, identifiers) => {
    const markup = renderToStaticMarkup(<LocalAgentsPage initialQueenWorkflow={{ status: "idle", log: [message] }} />);
    expect(markup).toContain(translated);
    expect(markup).toContain(identifiers);
    expect(markup).not.toContain(message);
  });

  it.each(["unobserved", "committed", "uncertain"] as const)("keeps %s readback distinct from execution completion in Chinese", state => {
    const status: QueenPlanningStatus = {
      task: { taskId: "fixture-task", taskVersion: 1, status: "open" }, canApprove: false, executionVerified: false,
      request: { requestId: "fixture-request", taskVersion: 1, authorizationCurrent: true, graphRevision: 1,
        taskFingerprint: `sha256:${"a".repeat(64)}`, planningOperationStatus: state, plan: null,
        approval: { approvalId: "fixture-approval", approved: true, authorizationCurrent: true, operationStatus: state } },
    };
    const copy = localQueenCopy(queenPlanningStatusLabel(status), "zh-CN");
    expect(copy).toContain(`规划状态：${state}`);
    expect(copy).toContain(`审批状态：${state}（已批准）`);
    expect(copy).toContain("记录审批不等于执行任务");
    expect(copy).toContain("执行结果尚未验证");
    expect(copy).not.toContain("Execution not verified");
    status.request!.authorizationCurrent = false;
    expect(localQueenCopy(queenPlanningStatusLabel(status), "zh-CN"))
      .toContain("授权已过期、撤销或失效（服务端未区分具体原因），审批已禁用");
  });

  it.each([
    ["No committed graph read back for this task. Queued is not generated; refresh persisted status. No demonstration fallback.", "排队不等于生成完成"],
    ["Wallet session invalidated. Sign in again to read private plans.", "重新签名登录"],
    ["Click Sign in and read to sign in again. No automatic signature or mutation retry.", "不会自动签名或重试写入操作"],
    ["Planning producer/worker readiness is not enabled on this host. History can still be read; no flags were changed.", "未修改任何开关"],
    ["Readback unavailable. Refresh status before any further action; do not assume a mutation failed or retry execution.", "不能据此认定写入失败或重试执行"],
  ])("translates failure/empty-state guidance without granting capabilities: %s", (english, chinese) => {
    const result = localQueenCopy(english, "zh-CN");
    expect(result).toContain(chinese);
    expect(result).not.toContain(english);
    expect(localQueenCopy(english, "en")).toBe(english);
  });

  it("does not translate model IDs, fingerprints or error codes", () => {
    const identifiers = `personal-ai-agent-runtime-v4-1 AUTH_SESSION_INVALID sha256:${"b".repeat(64)} graphRevision: 3`;
    expect(localQueenCopy(identifiers, "zh-CN")).toBe(identifiers);
  });
});
