import assert from "node:assert/strict";
import test from "node:test";

import { findLatestSellerEmail, subjectHasExactDealId } from "./gmailMatching.js";
import type { SentEmailMetadata } from "./gmailMatching.js";
import { buildTargetedDealSearchQuery } from "./clients/gmailClient.js";

const messages: SentEmailMetadata[] = [
  { messageId: "older", subject: "[HS-DEAL-12345] First follow-up", from: null, sentAt: "2026-08-01T10:00:00.000Z" },
  { messageId: "newer", subject: "Re: [HS-DEAL-12345] Proposal", from: null, sentAt: "2026-08-10T10:00:00.000Z" },
  { messageId: "wrong", subject: "[HS-DEAL-1234] Similar ID", from: null, sentAt: "2026-08-11T10:00:00.000Z" },
];

test("exact bracketed deal ID subject matches", () => {
  assert.equal(subjectHasExactDealId("[HS-DEAL-12345] Proposal follow-up", "12345"), true);
});

test("similar but wrong deal ID and unbracketed forms do not match", () => {
  assert.equal(subjectHasExactDealId("[HS-DEAL-1234] Similar", "12345"), false);
  assert.equal(subjectHasExactDealId("HS-DEAL-12345 Proposal", "12345"), false);
  assert.equal(subjectHasExactDealId("Deal 12345", "12345"), false);
});

test("newest matching sent message is selected", () => {
  assert.deepEqual(findLatestSellerEmail("12345", messages), {
    dealId: "12345",
    messageId: "newer",
    subject: "Re: [HS-DEAL-12345] Proposal",
    sentAt: "2026-08-10T10:00:00.000Z",
  });
});

test("no matching sent email returns null", () => {
  assert.equal(findLatestSellerEmail("99999", messages), null);
});

test("targeted Gmail query uses the exact bracketed deal ID", () => {
  assert.equal(buildTargetedDealSearchQuery("12345"), 'subject:"[HS-DEAL-12345]"');
});

test("one deal query cannot accidentally search another deal ID", () => {
  const query = buildTargetedDealSearchQuery("12345");
  assert.equal(query.includes("[HS-DEAL-1234]"), false);
  assert.notEqual(query, buildTargetedDealSearchQuery("1234"));
});
