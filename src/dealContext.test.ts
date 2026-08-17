import assert from "node:assert/strict";
import test from "node:test";

import { buildDealContext } from "./dealContext.js";
import type { DealCalendarEvent } from "./calendarMatching.js";
import type { HubSpotDealRecord, SellerEmailRecord } from "./types.js";

const deal: HubSpotDealRecord = {
  id: "12345",
  dealName: "Fixture deal",
  amount: 18_000,
  closeDate: "2026-09-15T00:00:00.000Z",
  pipelineId: "default",
  stageId: "proposal",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
  nextStep: "Follow up",
  isClosed: false,
};

const email: SellerEmailRecord = {
  dealId: deal.id,
  messageId: "message-1",
  subject: "[HS-DEAL-12345] Follow-up",
  sentAt: "2026-08-10T12:00:00.000Z",
};

const meeting: DealCalendarEvent = {
  dealId: deal.id,
  eventId: "event-1",
  summary: "[HS-DEAL-12345] Decision call",
  startAt: "2026-08-18T10:30:00.000Z",
};

test("DealContext normalizes Gmail and Calendar evidence when both are present", () => {
  const context = buildDealContext(deal, email, meeting);
  assert.equal(context.lastSellerEmailAt, email.sentAt);
  assert.equal(context.nextMeetingAt, meeting.startAt);
});

test("DealContext supports Gmail present and Calendar absent", () => {
  const context = buildDealContext(deal, email, null);
  assert.equal(context.lastSellerEmailAt, email.sentAt);
  assert.equal(context.nextMeetingAt, null);
});

test("DealContext supports Gmail absent and Calendar present", () => {
  const context = buildDealContext(deal, null, meeting);
  assert.equal(context.lastSellerEmailAt, null);
  assert.equal(context.nextMeetingAt, meeting.startAt);
});

test("DealContext preserves null when both evidence sources are absent", () => {
  const context = buildDealContext(deal, null, null);
  assert.equal(context.lastSellerEmailAt, null);
  assert.equal(context.nextMeetingAt, null);
});

test("DealContext rejects a mismatched seller-email deal ID", () => {
  assert.throws(() => buildDealContext(deal, { ...email, dealId: "other" }, meeting), /Seller email deal ID/u);
});

test("DealContext rejects a mismatched Calendar deal ID", () => {
  assert.throws(() => buildDealContext(deal, email, { ...meeting, dealId: "other" }), /Calendar meeting deal ID/u);
});
