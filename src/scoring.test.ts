import assert from "node:assert/strict";
import test from "node:test";

import { scoreDeal } from "./scoring.js";
import type { DealContext, RiskFlag } from "./types.js";

const EVALUATION_TIME = "2026-08-12T12:00:00.000Z";

const HEALTHY_DEAL: DealContext = {
  dealId: "fixture-1",
  dealName: "Healthy fixture",
  amount: 20_000,
  stageId: "proposal",
  closeDate: "2026-09-15T23:59:59.999Z",
  isClosed: false,
  nextStep: "Send revised proposal",
  lastSellerEmailAt: "2026-08-10T12:00:00.000Z",
  nextMeetingAt: "2026-08-20T12:00:00.000Z",
};

function fixture(overrides: Partial<DealContext>): DealContext {
  return { ...HEALTHY_DEAL, ...overrides };
}

function hasFlag(overrides: Partial<DealContext>, flag: RiskFlag): boolean {
  return scoreDeal(fixture(overrides), EVALUATION_TIME).flags.includes(flag);
}

test("healthy deal has no flags and zero severity", () => {
  const result = scoreDeal(HEALTHY_DEAL, EVALUATION_TIME);
  assert.deepEqual(result.flags, []);
  assert.equal(result.severityScore, 0);
});

test("full rescue case has every flag and severity 1.00", () => {
  const result = scoreDeal(fixture({
    lastSellerEmailAt: "2026-08-04T11:59:59.999Z",
    nextMeetingAt: null,
    nextStep: null,
    closeDate: "2026-08-20T23:59:59.999Z",
  }), EVALUATION_TIME);
  assert.deepEqual(result.flags, [
    "NO_RECENT_SELLER_EMAIL",
    "NO_NEXT_MEETING",
    "MISSING_NEXT_STEP",
    "CLOSE_DATE_RISK",
    "STALE_DEAL",
  ]);
  assert.equal(result.severityScore, 1);
});

test("missing seller email is flagged", () => {
  assert.equal(hasFlag({ lastSellerEmailAt: null }, "NO_RECENT_SELLER_EMAIL"), true);
});

test("email exactly seven days old is not flagged", () => {
  assert.equal(hasFlag({ lastSellerEmailAt: "2026-08-05T12:00:00.000Z" }, "NO_RECENT_SELLER_EMAIL"), false);
});

test("email more than seven days old is flagged", () => {
  assert.equal(hasFlag({ lastSellerEmailAt: "2026-08-05T11:59:59.999Z" }, "NO_RECENT_SELLER_EMAIL"), true);
});

test("meeting after close date is treated as no next meeting", () => {
  assert.equal(hasFlag({
    closeDate: "2026-08-20T12:00:00.000Z",
    nextMeetingAt: "2026-08-20T12:00:00.001Z",
  }, "NO_NEXT_MEETING"), true);
});

test("future meeting before close date is valid", () => {
  assert.equal(hasFlag({
    closeDate: "2026-08-20T12:00:00.000Z",
    nextMeetingAt: "2026-08-20T12:00:00.000Z",
  }, "NO_NEXT_MEETING"), false);
});

test("whitespace-only next step is missing", () => {
  assert.equal(hasFlag({ nextStep: "  \t " }, "MISSING_NEXT_STEP"), true);
});

test("past close date creates close-date risk", () => {
  assert.equal(hasFlag({ closeDate: "2026-08-11T23:59:59.999Z" }, "CLOSE_DATE_RISK"), true);
});

test("close date exactly fourteen calendar days away plus missing next step creates risk", () => {
  assert.equal(hasFlag({
    closeDate: "2026-08-26T00:00:00.000Z",
    nextStep: null,
  }, "CLOSE_DATE_RISK"), true);
});

test("null close date does not create close-date risk", () => {
  assert.equal(hasFlag({ closeDate: null, nextStep: null }, "CLOSE_DATE_RISK"), false);
});

test("closed deal ignores otherwise bad data", () => {
  const result = scoreDeal(fixture({
    isClosed: true,
    closeDate: "2026-01-01T00:00:00.000Z",
    lastSellerEmailAt: null,
    nextMeetingAt: null,
    nextStep: " ",
  }), EVALUATION_TIME);
  assert.deepEqual(result.flags, []);
  assert.equal(result.severityScore, 0);
});
