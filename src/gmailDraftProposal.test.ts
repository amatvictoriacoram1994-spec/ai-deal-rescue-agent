import assert from "node:assert/strict";
import test from "node:test";

import { buildGmailDraftProposal } from "./gmailDraftProposal.js";
import type { ClaudeDealExplanation } from "./claudeContracts.js";

const healthy: ClaudeDealExplanation = {
  dealId: "northstar",
  dealName: "Northstar",
  severityScore: 0,
  riskFlags: [],
  summary: "No deterministic risk.",
  recommendedAction: "No rescue intervention.",
  actionPriority: "none",
};

test("healthy no-action explanation cannot produce a draft candidate", () => {
  assert.equal(buildGmailDraftProposal(healthy, "developer@example.com"), null);
});

test("internal Claude recommendation is transformed into safe external copy", () => {
  const proposal = buildGmailDraftProposal({
    ...healthy,
    dealId: "vertex",
    dealName: "Vertex Systems - Platform Upgrade",
    severityScore: 1,
    riskFlags: ["NO_RECENT_SELLER_EMAIL", "NO_NEXT_MEETING", "MISSING_NEXT_STEP", "CLOSE_DATE_RISK", "STALE_DEAL"],
    recommendedAction: "Immediate manager intervention for this stale deal and close-date risk is required.",
    actionPriority: "intervene",
  }, "developer@example.com");
  assert.notEqual(proposal, null);
  assert.equal(proposal?.subject, "Next steps for Vertex Systems platform upgrade");
  assert.equal(proposal?.body, [
    "Hi,",
    "",
    "I wanted to follow up on the next steps for Vertex Systems platform upgrade.",
    "",
    "Would you be available for a quick call this week to confirm the remaining decision points and timeline? If there is anything you need from our side before then, I’m happy to send it over.",
    "",
    "Best,",
    "Abhishek",
  ].join("\n"));
  assert.equal(/deal rescue|stale|risk|intervention|manager|crm|severity/iu.test(`${proposal?.subject}\n${proposal?.body}`), false);
});
