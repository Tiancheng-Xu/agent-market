import {
  RiskAssessmentInputSchema,
  RiskAssessorResultSchema,
  type RiskAssessmentInput,
  type RiskAssessorResult,
} from "@agent-market/shared-contracts";

export type RiskAssessorExecutionRequest = {
  role: "risk_assessor";
  messages: Array<{ role: "system" | "user"; content: string }>;
};

export type RiskAssessorExecutor = (
  request: RiskAssessorExecutionRequest,
) => Promise<string>;

const REDACTIONS: Array<[RegExp, string]> = [
  [/\b(?:sk|pk|api)[-_][a-z0-9_-]{8,}\b/giu, "[redacted-secret]"],
  [/0x[0-9a-f]{64}/giu, "[redacted-private-key]"],
  [/(?:\/Users|\/home)\/[a-z0-9._-]+(?:\/[a-z0-9._-]+)+/giu, "[redacted-local-path]"],
];

function sanitize(value: string): string {
  return REDACTIONS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), value);
}

function sanitizedInput(input: RiskAssessmentInput): RiskAssessmentInput {
  return {
    ...input,
    title: sanitize(input.title),
    description: sanitize(input.description),
    requirements: input.requirements.map(sanitize),
    declaredPermissions: input.declaredPermissions.map(sanitize),
    dependencyClasses: input.dependencyClasses.map(sanitize),
  };
}

export async function assessTaskRisk(
  rawInput: RiskAssessmentInput,
  executeAgentText: RiskAssessorExecutor,
): Promise<RiskAssessorResult> {
  const input = sanitizedInput(RiskAssessmentInputSchema.parse(rawInput));
  const response = await executeAgentText({
    role: "risk_assessor",
    messages: [
      {
        role: "system",
        content: [
          "Assess task risk only.",
          "Return one strict JSON object with factors and reasonCodes.",
          "All eight factor values must be integer scores from 0 to 100.",
          "Never return a tier, rate, deposit, settlement, wallet decision, or prose.",
        ].join(" "),
      },
      { role: "user", content: JSON.stringify(input) },
    ],
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.trim());
  } catch {
    throw new Error("RISK_ASSESSMENT_INVALID");
  }
  const result = RiskAssessorResultSchema.safeParse(parsed);
  if (!result.success) throw new Error("RISK_ASSESSMENT_INVALID");
  return result.data;
}

export function conservativeRiskFallback(rawInput: RiskAssessmentInput): RiskAssessorResult {
  const input = RiskAssessmentInputSchema.parse(rawInput);
  const text = [input.title, input.description, ...input.requirements, ...input.declaredPermissions, ...input.dependencyClasses]
    .join(" ")
    .toLowerCase();
  const includesAny = (...terms: string[]) => terms.some((term) => text.includes(term));
  const factors = {
    complexity: includesAny("multi-agent", "workflow", "migration", "多智能体", "工作流", "迁移") ? 65 : 30,
    acceptanceAmbiguity: includesAny("subjective", "creative", "approximately", "主观", "创意", "大约") ? 70 : 30,
    externalDependency: input.dependencyClasses.length > 0 ? 65 : 30,
    dataSensitivity: includesAny("secret", "private", "pii", "credential", "隐私", "密钥", "凭据") ? 85 : 30,
    financialRisk: includesAny("payment", "wallet", "escrow", "refund", "付款", "钱包", "托管", "退款") ? 85 : 30,
    irreversibility: includesAny("delete", "deploy", "publish", "transfer", "删除", "部署", "发布", "转账") ? 80 : 30,
    deadlineRisk: input.durationHours <= 24 ? 70 : input.durationHours <= 72 ? 50 : 30,
    agentUncertainty: 40,
  };
  return RiskAssessorResultSchema.parse({
    factors,
    reasonCodes: ["assessor_unavailable_conservative_fallback"],
  });
}

export async function assessTaskRiskWithFallback(
  input: RiskAssessmentInput,
  executeAgentText: RiskAssessorExecutor,
): Promise<RiskAssessorResult> {
  try {
    return await assessTaskRisk(input, executeAgentText);
  } catch {
    return conservativeRiskFallback(input);
  }
}
