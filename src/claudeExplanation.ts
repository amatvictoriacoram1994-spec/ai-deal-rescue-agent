import { actionPriorityForSeverity, validateClaudeOutput } from "./claudeContracts.js";
import type { ClaudeExplanationInput, ClaudeExplanationOutput } from "./claudeContracts.js";
import type { LiveRiskResult } from "./liveRiskPipeline.js";

const ANTHROPIC_MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const REPORT_TOOL_NAME = "report_deal_risk_explanations";

const SYSTEM_GUARDRAILS = `You are a reporting and recommendation layer for already-scored deals.
Deterministic scores and risk flags are authoritative. Never change severityScore, add/remove/reorder risk flags, or reorder deals.
Never claim buyer sentiment, predict that a deal will definitely close or fail, or invent emails, meetings, CRM activity, dates, or customer facts.
Ground recommendations only in supplied flags: NO_RECENT_SELLER_EMAIL means seller follow-up; NO_NEXT_MEETING means schedule a buyer meeting; MISSING_NEXT_STEP means update CRM with a concrete next action; CLOSE_DATE_RISK means manager/seller intervention on the close plan; STALE_DEAL means immediate deal review.
For zero severity and no flags, recommend no rescue intervention.
Copy all deterministic fields exactly. Use the required report tool exactly once.`;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["generatedAt", "deals"],
  properties: {
    generatedAt: { type: "string" },
    deals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["dealId", "dealName", "severityScore", "riskFlags", "summary", "recommendedAction", "actionPriority"],
        properties: {
          dealId: { type: "string" },
          dealName: { type: "string" },
          severityScore: { type: "number" },
          riskFlags: { type: "array", items: { type: "string", enum: ["NO_RECENT_SELLER_EMAIL", "NO_NEXT_MEETING", "MISSING_NEXT_STEP", "CLOSE_DATE_RISK", "STALE_DEAL"] } },
          summary: { type: "string", minLength: 1 },
          recommendedAction: { type: "string", minLength: 1 },
          actionPriority: { type: "string", enum: ["none", "monitor", "intervene"] },
        },
      },
    },
  },
} as const;

export function buildClaudeExplanationInput(evaluationTime: string, results: readonly LiveRiskResult[]): ClaudeExplanationInput {
  const ranked = results.map((result, index) => ({ result, index }))
    .sort((left, right) => right.result.risk.severityScore - left.result.risk.severityScore || left.index - right.index);
  return {
    evaluationTime,
    deals: ranked.map(({ result }) => ({
      dealId: result.context.dealId,
      dealName: result.context.dealName,
      severityScore: result.risk.severityScore,
      flags: [...result.risk.flags],
      daysSinceLastSellerEmail: result.risk.daysSinceLastSellerEmail,
      daysUntilClose: result.risk.daysUntilClose,
      hasFutureMeeting: result.context.nextMeetingAt !== null,
      hasNextStep: Boolean(result.context.nextStep?.trim()),
    })),
  };
}

export async function generateClaudeExplanations(input: ClaudeExplanationInput): Promise<ClaudeExplanationOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.");
  const model = process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
  const deterministicPriorities = input.deals.map((deal) => ({
    dealId: deal.dealId,
    actionPriority: actionPriorityForSeverity(deal.severityScore),
  }));
  let response: Response;
  try {
    response = await fetch(ANTHROPIC_MESSAGES_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2_048,
        system: SYSTEM_GUARDRAILS,
        messages: [{
          role: "user",
          content: `Explain this normalized deterministic report. generatedAt must equal evaluationTime. Copy deterministic fields and priorities exactly.\n${JSON.stringify({ ...input, deterministicPriorities })}`,
        }],
        tools: [{
          name: REPORT_TOOL_NAME,
          description: "Return the final structured deal-risk explanation report. This reports already-scored data and must not alter deterministic fields.",
          input_schema: OUTPUT_SCHEMA,
        }],
        tool_choice: { type: "tool", name: REPORT_TOOL_NAME },
      }),
    });
  } catch {
    throw new Error("Claude request failed before a response was received.");
  }
  if (!response.ok) throw new Error(`Claude request failed with HTTP ${response.status} ${response.statusText}.`);
  const body = await response.json() as { content?: unknown };
  if (!Array.isArray(body.content)) throw new Error("Claude returned an invalid Messages API response.");
  const toolBlocks = body.content.filter((block): block is { type: "tool_use"; name: string; input: unknown } => {
    return typeof block === "object" && block !== null
      && (block as { type?: unknown }).type === "tool_use"
      && (block as { name?: unknown }).name === REPORT_TOOL_NAME
      && "input" in block;
  });
  if (toolBlocks.length !== 1) throw new Error("Claude did not return exactly one structured explanation report.");
  return validateClaudeOutput(toolBlocks[0]?.input, input);
}
