import assert from "node:assert/strict";
import test from "node:test";

import {
  listFutureCalendarEvents,
  resetCalendarAuthCacheForTesting,
} from "./calendarClient.js";

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
const EVALUATION_TIME = "2026-08-14T12:30:00+05:30";
const originalFetch = globalThis.fetch;

test("Calendar handles one 401 refresh, transient retry, and pagination", async () => {
  resetCalendarAuthCacheForTesting({ value: "stored", expiryDate: Date.now() + 3_600_000 });
  let refreshes = 0;
  const calendarUrls: string[] = [];
  const calendarResponses = [
    new Response(null, { status: 401 }),
    new Response(null, { status: 429, headers: { "Retry-After": "0" } }),
    Response.json({
      items: [{ id: "first", summary: "First", status: "confirmed", start: { dateTime: "2026-08-18T10:30:00Z" } }],
      nextPageToken: "page-2",
    }),
    Response.json({
      items: [{ id: "second", summary: "Second", status: "confirmed", start: { date: "2026-08-19" } }],
    }),
  ];
  globalThis.fetch = async (input): Promise<Response> => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      refreshes += 1;
      return Response.json({ access_token: "refreshed", scope: CALENDAR_SCOPE, expires_in: 3_600 });
    }
    calendarUrls.push(url);
    const response = calendarResponses.shift();
    if (response === undefined) throw new Error("Unexpected mocked Calendar request.");
    return response;
  };
  try {
    const events = await listFutureCalendarEvents(EVALUATION_TIME);
    assert.deepEqual(events.map((event) => event.id), ["first", "second"]);
    assert.equal(refreshes, 1);
    assert.equal(calendarUrls.length, 4);
    const firstUrl = new URL(calendarUrls[0] ?? "");
    assert.equal(firstUrl.pathname, "/calendar/v3/calendars/primary/events");
    assert.equal(firstUrl.searchParams.get("timeMin"), "2026-08-14T07:00:00.000Z");
    assert.equal(firstUrl.searchParams.get("singleEvents"), "true");
    assert.equal(firstUrl.searchParams.get("orderBy"), "startTime");
    assert.equal(firstUrl.searchParams.get("fields"), "nextPageToken,items(id,summary,status,start(date,dateTime),end(date,dateTime))");
    assert.equal(new URL(calendarUrls[3] ?? "").searchParams.get("pageToken"), "page-2");
  } finally {
    globalThis.fetch = originalFetch;
    resetCalendarAuthCacheForTesting();
  }
});

test("Calendar retries a 401 at most once", async () => {
  resetCalendarAuthCacheForTesting({ value: "stored", expiryDate: Date.now() + 3_600_000 });
  let refreshes = 0;
  let calendarRequests = 0;
  globalThis.fetch = async (input): Promise<Response> => {
    if (String(input).includes("oauth2.googleapis.com/token")) {
      refreshes += 1;
      return Response.json({ access_token: "refreshed", scope: CALENDAR_SCOPE, expires_in: 3_600 });
    }
    calendarRequests += 1;
    return new Response(null, { status: 401 });
  };
  try {
    await assert.rejects(listFutureCalendarEvents(EVALUATION_TIME), /HTTP 401/u);
    assert.equal(refreshes, 1);
    assert.equal(calendarRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    resetCalendarAuthCacheForTesting();
  }
});
