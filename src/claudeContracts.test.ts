import assert from "node:assert/strict";
import test from "node:test";

import { validateClaudeOutputJson } from "./claudeContracts.js";
import type { ClaudeExplanationInput } from "./claudeContracts.js";

const input: ClaudeExplanationInput = {
  evaluationTime: "2026-08-14T12:30:00+05:30",
  deals: [
    { dealId: "vertex", dealName: "Vertex", severityScore: 1, flags: ["NO_RECENT_SELLER_EMAIL", "NO_NEXT_MEETING"], daysSinceLastSellerEmail: null, daysUntilClose: 11, hasFutureMeeting: false, hasNextStep: false },
    { dealId: "northstar", dealName: "Northstar", severityScore: 0, flags: [], daysSinceLastSellerEmail: 1, daysUntilClose: 32, hasFutureMeeting: true, hasNextStep: true },
  ],
};

const valid = {
  generatedAt: input.evaluationTime,
  deals: [
    { dealId: "vertex", dealName: "Vertex", severityScore: 1, riskFlags: ["NO_RECENT_SELLER_EMAIL", "NO_NEXT_MEETING"], summary: "Risk requires attention.", recommendedAction: "Follow up and schedule a meeting.", actionPriority: "intervene" },
    { dealId: "northstar", dealName: "Northstar", severityScore: 0, riskFlags: [], summary: "No deterministic risk flags.", recommendedAction: "No rescue intervention.", actionPriority: "none" },
  ],
};

function changed(mutator: (copy: any) => void): string {
  const copy = structuredClone(valid);
  mutator(copy);
  return JSON.stringify(copy);
}

test("valid Claude output is accepted", () => assert.deepEqual(validateClaudeOutputJson(JSON.stringify(valid), input), valid));
test("modified severity is rejected", () => assert.throws(() => validateClaudeOutputJson(changed((v) => { v.deals[0].severityScore = 0.5; }), input), /severity/u));
test("missing flag is rejected", () => assert.throws(() => validateClaudeOutputJson(changed((v) => { v.deals[0].riskFlags.pop(); }), input), /risk flag/u));
test("invented flag is rejected", () => assert.throws(() => validateClaudeOutputJson(changed((v) => { v.deals[0].riskFlags.push("INVENTED"); }), input), /risk flag/u));
test("changed deal ID is rejected", () => assert.throws(() => validateClaudeOutputJson(changed((v) => { v.deals[0].dealId = "other"; }), input), /deal ID/u));
test("reversed deterministic order is rejected", () => assert.throws(() => validateClaudeOutputJson(changed((v) => { v.deals.reverse(); }), input), /deal ID|ordering/u));
test("healthy deal cannot become intervene", () => assert.throws(() => validateClaudeOutputJson(changed((v) => { v.deals[1].actionPriority = "intervene"; }), input), /priority/u));
test("high-risk deal cannot become none", () => assert.throws(() => validateClaudeOutputJson(changed((v) => { v.deals[0].actionPriority = "none"; }), input), /priority/u));
test("malformed JSON fails closed", () => assert.throws(() => validateClaudeOutputJson("{not-json", input), /valid JSON/u));
