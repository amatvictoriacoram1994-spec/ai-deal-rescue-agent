import assert from "node:assert/strict";

import { buildClaudeExplanationInput, generateClaudeExplanations } from "./claudeExplanation.js";
import { collectControlledLiveRisk } from "./liveRiskPipeline.js";

const EVALUATION_TIME = "2026-08-14T12:30:00+05:30";
const VERTEX_FLAGS = ["NO_RECENT_SELLER_EMAIL", "NO_NEXT_MEETING", "MISSING_NEXT_STEP", "CLOSE_DATE_RISK", "STALE_DEAL"];

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error("ANTHROPIC_API_KEY is not configured; live Claude test was not run.");
  const input = buildClaudeExplanationInput(EVALUATION_TIME, await collectControlledLiveRisk(EVALUATION_TIME));
  const [vertex, northstar] = input.deals;
  assert.equal(vertex?.dealId, "341673944815");
  assert.equal(vertex.severityScore, 1);
  assert.deepEqual(vertex.flags, VERTEX_FLAGS);
  assert.equal(northstar?.dealId, "341678981821");
  assert.equal(northstar.severityScore, 0);
  assert.deepEqual(northstar.flags, []);

  const output = await generateClaudeExplanations(input);
  console.log("Sanitized Claude deal-risk explanations:");
  console.table(output.deals.map((deal) => ({
    dealName: deal.dealName,
    severityScore: deal.severityScore,
    riskFlags: deal.riskFlags.join(", "),
    summary: deal.summary,
    recommendedAction: deal.recommendedAction,
    actionPriority: deal.actionPriority,
  })));
}

main().catch((error: unknown) => {
  console.error(`Claude live test failed: ${error instanceof Error ? error.message : "Unknown error."}`);
  process.exitCode = 1;
});
