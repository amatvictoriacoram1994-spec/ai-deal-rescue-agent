import type { RiskFlag } from "./types.js";

export type ActionPriority = "none" | "monitor" | "intervene";

export type ClaudeDealInput = {
  dealId: string;
  dealName: string;
  severityScore: number;
  flags: RiskFlag[];
  daysSinceLastSellerEmail: number | null;
  daysUntilClose: number | null;
  hasFutureMeeting: boolean;
  hasNextStep: boolean;
};

export type ClaudeExplanationInput = {
  evaluationTime: string;
  deals: ClaudeDealInput[];
};

export type ClaudeDealExplanation = {
  dealId: string;
  dealName: string;
  severityScore: number;
  riskFlags: RiskFlag[];
  summary: string;
  recommendedAction: string;
  actionPriority: ActionPriority;
};

export type ClaudeExplanationOutput = {
  generatedAt: string;
  deals: ClaudeDealExplanation[];
};

const RISK_FLAGS: readonly RiskFlag[] = [
  "NO_RECENT_SELLER_EMAIL",
  "NO_NEXT_MEETING",
  "MISSING_NEXT_STEP",
  "CLOSE_DATE_RISK",
  "STALE_DEAL",
];

export function actionPriorityForSeverity(severityScore: number): ActionPriority {
  if (severityScore === 0) return "none";
  return severityScore < 0.5 ? "monitor" : "intervene";
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an invalid schema.`);
  }
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be non-empty text.`);
  return value;
}

export function validateClaudeOutput(value: unknown, input: ClaudeExplanationInput): ClaudeExplanationOutput {
  const root = objectValue(value, "Claude output");
  exactKeys(root, ["generatedAt", "deals"], "Claude output");
  if (root.generatedAt !== input.evaluationTime) throw new Error("Claude changed the deterministic generatedAt value.");
  if (!Array.isArray(root.deals) || root.deals.length !== input.deals.length) {
    throw new Error("Claude output omitted or added a deal.");
  }
  const deals = root.deals.map((candidate, index): ClaudeDealExplanation => {
    const outputDeal = objectValue(candidate, `Claude deal ${index}`);
    exactKeys(outputDeal, [
      "dealId", "dealName", "severityScore", "riskFlags", "summary", "recommendedAction", "actionPriority",
    ], `Claude deal ${index}`);
    const expected = input.deals[index];
    if (expected === undefined) throw new Error("Claude output added an unknown deal.");
    if (outputDeal.dealId !== expected.dealId) throw new Error("Claude changed a deal ID or deterministic deal ordering.");
    if (outputDeal.dealName !== expected.dealName) throw new Error("Claude changed a deal name.");
    if (outputDeal.severityScore !== expected.severityScore) throw new Error("Claude changed a deterministic severity score.");
    if (!Array.isArray(outputDeal.riskFlags)) throw new Error("Claude riskFlags must be an array.");
    if (outputDeal.riskFlags.length !== expected.flags.length
      || outputDeal.riskFlags.some((flag, flagIndex) => flag !== expected.flags[flagIndex])) {
      throw new Error("Claude added, removed, reordered, or invented a deterministic risk flag.");
    }
    if (outputDeal.riskFlags.some((flag) => typeof flag !== "string" || !RISK_FLAGS.includes(flag as RiskFlag))) {
      throw new Error("Claude returned an unknown risk flag.");
    }
    const expectedPriority = actionPriorityForSeverity(expected.severityScore);
    if (outputDeal.actionPriority !== expectedPriority) throw new Error("Claude returned an action priority inconsistent with severity.");
    return {
      dealId: expected.dealId,
      dealName: expected.dealName,
      severityScore: expected.severityScore,
      riskFlags: [...expected.flags],
      summary: requiredText(outputDeal.summary, "Claude summary"),
      recommendedAction: requiredText(outputDeal.recommendedAction, "Claude recommendedAction"),
      actionPriority: expectedPriority,
    };
  });
  return { generatedAt: input.evaluationTime, deals };
}

export function validateClaudeOutputJson(json: string, input: ClaudeExplanationInput): ClaudeExplanationOutput {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    throw new Error("Claude output is not valid JSON.");
  }
  return validateClaudeOutput(value, input);
}
