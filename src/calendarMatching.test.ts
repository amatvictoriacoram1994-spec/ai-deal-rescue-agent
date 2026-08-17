import assert from "node:assert/strict";
import test from "node:test";

import {
  calendarSummaryHasExactDealId,
  findEarliestFutureDealEvent,
} from "./calendarMatching.js";
import type { CalendarEventMetadata } from "./calendarMatching.js";

const EVALUATION_TIME = "2026-08-14T12:30:00+05:30";

function event(id: string, summary: string, start: string, status = "confirmed"): CalendarEventMetadata {
  return { id, summary, status, start: { dateTime: start } };
}

test("exact bracketed Calendar deal ID matches", () => {
  assert.equal(calendarSummaryHasExactDealId("[HS-DEAL-12345] Decision call", "12345"), true);
});

test("similar Calendar deal ID does not match", () => {
  assert.equal(calendarSummaryHasExactDealId("[HS-DEAL-1234] Decision call", "12345"), false);
});

test("cancelled and past events are ignored", () => {
  const events = [
    event("cancelled", "[HS-DEAL-12345] Cancelled", "2026-08-18T16:00:00+05:30", "cancelled"),
    event("past", "[HS-DEAL-12345] Past", "2026-08-13T16:00:00+05:30"),
  ];
  assert.equal(findEarliestFutureDealEvent("12345", events, EVALUATION_TIME), null);
});

test("earliest valid upcoming matching event is selected", () => {
  const events = [
    event("later", "[HS-DEAL-12345] Later", "2026-08-20T16:00:00+05:30"),
    event("earlier", "Proposal [HS-DEAL-12345]", "2026-08-18T16:00:00+05:30"),
  ];
  assert.deepEqual(findEarliestFutureDealEvent("12345", events, EVALUATION_TIME), {
    dealId: "12345",
    eventId: "earlier",
    summary: "Proposal [HS-DEAL-12345]",
    startAt: "2026-08-18T10:30:00.000Z",
  });
});

test("missing and malformed starts are handled safely", () => {
  const events: CalendarEventMetadata[] = [
    { id: "missing", summary: "[HS-DEAL-12345] Missing" },
    { id: "malformed", summary: "[HS-DEAL-12345] Malformed", start: { dateTime: "not-a-date" } },
  ];
  assert.equal(findEarliestFutureDealEvent("12345", events, EVALUATION_TIME), null);
});
