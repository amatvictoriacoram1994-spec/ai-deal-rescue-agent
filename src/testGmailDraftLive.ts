import assert from "node:assert/strict";

import { createGmailDraft } from "./clients/gmailDraftClient.js";
import { buildClaudeExplanationInput, generateClaudeExplanations } from "./claudeExplanation.js";
import { buildGmailDraftProposal } from "./gmailDraftProposal.js";
import { collectControlledLiveRisk } from "./liveRiskPipeline.js";

const EVALUATION_TIME = "2026-08-14T12:30:00+05:30";
const VERTEX_DEAL_ID = "341673944815";

async function main(): Promise<void> {
  if (process.env.APPROVE_DRAFT_CREATE !== "YES") {
    console.log("Draft creation not approved. No Gmail write performed.");
    return;
  }
  const recipient = process.env.DRAFT_TEST_TO?.trim();
  if (!recipient) throw new Error("DRAFT_TEST_TO is required for the controlled live draft test.");

  const risks = await collectControlledLiveRisk(EVALUATION_TIME);
  const claudeInput = buildClaudeExplanationInput(EVALUATION_TIME, risks);
  const explanations = await generateClaudeExplanations(claudeInput);
  const vertex = explanations.deals.find((deal) => deal.dealId === VERTEX_DEAL_ID);
  if (vertex === undefined) throw new Error("Validated Claude output omitted the controlled Vertex deal.");
  assert.equal(vertex.severityScore, 1, "Vertex severity fixture mismatch.");
  assert.equal(vertex.actionPriority, "intervene", "Vertex priority fixture mismatch.");
  const proposal = buildGmailDraftProposal(vertex, recipient);
  if (proposal === null) throw new Error("Vertex did not produce a draft proposal.");
  const result = await createGmailDraft(proposal, { approved: true, approvedBy: "human", dealId: VERTEX_DEAL_ID });
  console.table([{
    dealName: vertex.dealName,
    dealId: vertex.dealId,
    draftCreated: true,
    draftId: result.draftId,
    recipientConfigured: true,
  }]);
}

main().catch((error: unknown) => {
  console.error(`Gmail draft live test failed: ${error instanceof Error ? error.message : "Unknown error."}`);
  process.exitCode = 1;
});
