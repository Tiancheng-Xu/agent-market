import { z } from "zod";

const SafeCodeSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/);
const OpaqueRefSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/);
const Hex64Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const JevDecisionTypeSchema = z.enum([
  "agent_match",
  "agent_quality",
  "dispute_route",
]);

export const JevDisputeRouteSchema = z.enum([
  "judge",
  "red_team",
  "repair",
  "ai_final_arbiter_review",
]);

export const EligibilityDecisionV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  decisionType: z.literal("eligibility"),
  decisionId: OpaqueRefSchema,
  candidateRef: OpaqueRefSchema,
  passedImplementedGates: z.boolean(),
  passedAllRequiredGates: z.boolean(),
  implementedGateCodes: z.array(SafeCodeSchema).max(32),
  missingRequiredGateCodes: z.array(SafeCodeSchema).max(32),
}).superRefine((decision, context) => {
  if (decision.passedAllRequiredGates && !decision.passedImplementedGates) {
    context.addIssue({
      code: "custom",
      message: "All required gates cannot pass when implemented gates failed",
    });
  }
  if (decision.passedAllRequiredGates && decision.missingRequiredGateCodes.length > 0) {
    context.addIssue({
      code: "custom",
      message: "A fully gated candidate cannot list missing gates",
    });
  }
});

export const JevMatchCandidateV1Schema = z.strictObject({
  candidateRef: OpaqueRefSchema,
  passedImplementedGates: z.literal(true),
  passedAllRequiredGates: z.boolean(),
  capabilityMatch: z.literal(true),
  health: z.enum(["online", "degraded"]),
  costBucket: z.enum(["free", "low", "medium", "high"]),
  latencyBucket: z.enum(["fast", "medium", "slow", "unknown"]),
  qualityBucket: z.number().int().min(1).max(5),
  newcomer: z.boolean(),
  allowedRiskCodes: z.array(SafeCodeSchema).max(24),
});

export const AgentMatchDecisionV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  decisionType: z.literal("agent_match"),
  decisionId: OpaqueRefSchema,
  taskRefHmac: Hex64Schema,
  requiredCapabilityCodes: z.array(SafeCodeSchema).min(1).max(24),
  candidates: z.array(JevMatchCandidateV1Schema).max(32),
}).superRefine((decision, context) => {
  const references = decision.candidates.map((candidate) => candidate.candidateRef);
  if (new Set(references).size !== references.length) {
    context.addIssue({ code: "custom", message: "Candidate references must be unique" });
  }
});

export const AgentQualityDecisionV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  decisionType: z.literal("agent_quality"),
  decisionId: OpaqueRefSchema,
  taskRefHmac: Hex64Schema,
  candidateRef: OpaqueRefSchema,
  completionStatus: z.enum(["completed", "needs_revision", "failed"]),
  retryBucket: z.enum(["none", "one", "multiple"]),
  latencyBucket: z.enum(["fast", "medium", "slow", "unknown"]),
  costBucket: z.enum(["free", "low", "medium", "high", "unknown"]),
  evidenceCompleteness: z.enum(["complete", "partial", "missing"]),
  reasonCodes: z.array(SafeCodeSchema).max(24),
});

export const DisputeRouteDecisionV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  decisionType: z.literal("dispute_route"),
  decisionId: OpaqueRefSchema,
  taskRefHmac: Hex64Schema,
  riskLevel: z.enum(["low", "medium", "high"]),
  judgeOutcome: z.enum(["approved", "needs_revision", "rejected", "unknown"]),
  retryBucket: z.enum(["none", "one", "multiple"]),
  evidenceCompleteness: z.enum(["complete", "partial", "missing"]),
  highRiskPolicyLocked: z.boolean(),
  permittedRoutes: z.array(JevDisputeRouteSchema).min(1).max(4),
  reasonCodes: z.array(SafeCodeSchema).max(24),
}).superRefine((decision, context) => {
  if (new Set(decision.permittedRoutes).size !== decision.permittedRoutes.length) {
    context.addIssue({ code: "custom", message: "Permitted routes must be unique" });
  }
});

const JevDecisionThresholdSchema = z.strictObject({
  minConfidence: z.number().min(0).max(1),
  minMargin: z.number().min(0).max(1),
});

export const JevThresholdPolicyV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  policyVersion: SafeCodeSchema,
  mode: z.enum(["synthetic-only", "shadow"]),
  calibrated: z.boolean(),
  match: JevDecisionThresholdSchema,
  quality: JevDecisionThresholdSchema,
  dispute: JevDecisionThresholdSchema,
});

export const JevFallbackReasonSchema = z.enum([
  "disabled",
  "missing_key",
  "timeout",
  "rate_limited",
  "unauthorized",
  "server_error",
  "invalid_response",
  "out_of_pool",
  "uncalibrated",
  "below_threshold",
]);

const JevDecisionEvidenceCommonShape = {
  schemaVersion: z.literal(1),
  decisionType: JevDecisionTypeSchema,
  decisionId: OpaqueRefSchema,
  correlationHmac: Hex64Schema,
  inputShapeHmac: Hex64Schema,
  policyVersion: SafeCodeSchema,
  modelVersion: z.string().min(1).max(80),
  latencyMs: z.number().int().nonnegative(),
  usage: z.strictObject({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
} as const;

export const JevDecisionFallbackEvidenceV1Schema = z.strictObject({
  ...JevDecisionEvidenceCommonShape,
  status: z.literal("fallback"),
  fallbackReason: JevFallbackReasonSchema,
});

export const JevDecisionObservedEvidenceV1Schema = z.strictObject({
  ...JevDecisionEvidenceCommonShape,
  status: z.literal("observed"),
  resultRefHash: Hex64Schema,
  confidence: z.number().min(0).max(1),
  margin: z.number().min(0).max(1),
});

export const JevDecisionEvidenceV1Schema = z.discriminatedUnion("status", [
  JevDecisionFallbackEvidenceV1Schema,
  JevDecisionObservedEvidenceV1Schema,
]);

export type JevDecisionType = z.infer<typeof JevDecisionTypeSchema>;
export type JevDisputeRoute = z.infer<typeof JevDisputeRouteSchema>;
export type EligibilityDecisionV1 = z.infer<typeof EligibilityDecisionV1Schema>;
export type AgentMatchDecisionV1 = z.infer<typeof AgentMatchDecisionV1Schema>;
export type AgentQualityDecisionV1 = z.infer<typeof AgentQualityDecisionV1Schema>;
export type DisputeRouteDecisionV1 = z.infer<typeof DisputeRouteDecisionV1Schema>;
export type JevThresholdPolicyV1 = z.infer<typeof JevThresholdPolicyV1Schema>;
export type JevFallbackReason = z.infer<typeof JevFallbackReasonSchema>;
export type JevDecisionFallbackEvidenceV1 = z.infer<typeof JevDecisionFallbackEvidenceV1Schema>;
export type JevDecisionObservedEvidenceV1 = z.infer<typeof JevDecisionObservedEvidenceV1Schema>;
export type JevDecisionEvidenceV1 = z.infer<typeof JevDecisionEvidenceV1Schema>;
