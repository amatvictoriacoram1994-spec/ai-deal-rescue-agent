import assert from "node:assert/strict";
import test from "node:test";

import {
  findLatestSellerEmailForDeal,
  resetGmailAuthCacheForTesting,
} from "./gmailClient.js";
import { getAllHubSpotDeals } from "./hubspotClient.js";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const originalFetch = globalThis.fetch;

test("Gmail refreshes once after 401 and reuses the refreshed token for later deals", async () => {
  resetGmailAuthCacheForTesting({ value: "stored", expiryDate: Date.now() + 3_600_000 });
  let refreshes = 0;
  let gmailRequests = 0;
  globalThis.fetch = async (input): Promise<Response> => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      refreshes += 1;
      return Response.json({ access_token: "refreshed", scope: GMAIL_SCOPE, expires_in: 3_600 });
    }
    gmailRequests += 1;
    if (gmailRequests === 1) return new Response(null, { status: 401 });
    return Response.json({ messages: [] });
  };
  try {
    assert.equal(await findLatestSellerEmailForDeal("test-1"), null);
    assert.equal(await findLatestSellerEmailForDeal("test-2"), null);
    assert.equal(refreshes, 1);
    assert.equal(gmailRequests, 3);
  } finally {
    globalThis.fetch = originalFetch;
    resetGmailAuthCacheForTesting();
  }
});

test("Gmail retries a 401 at most once", async () => {
  resetGmailAuthCacheForTesting({ value: "stored", expiryDate: Date.now() + 3_600_000 });
  let refreshes = 0;
  let gmailRequests = 0;
  globalThis.fetch = async (input): Promise<Response> => {
    if (String(input).includes("oauth2.googleapis.com/token")) {
      refreshes += 1;
      return Response.json({ access_token: "refreshed", scope: GMAIL_SCOPE, expires_in: 3_600 });
    }
    gmailRequests += 1;
    return new Response(null, { status: 401 });
  };
  try {
    await assert.rejects(findLatestSellerEmailForDeal("test-401"), /failed with HTTP 401/u);
    assert.equal(refreshes, 1);
    assert.equal(gmailRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    resetGmailAuthCacheForTesting();
  }
});

function hubSpotPage(id: string, after?: string): object {
  return {
    results: [{ id, properties: { dealname: `Deal ${id}`, hs_is_closed: "false" } }],
    ...(after === undefined ? {} : { paging: { next: { after } } }),
  };
}

test("HubSpot retries 429 and 5xx responses and preserves pagination", async () => {
  const responses = [
    new Response(null, { status: 429, headers: { "Retry-After": "0" } }),
    new Response(null, { status: 503, headers: { "Retry-After": "0" } }),
    Response.json(hubSpotPage("1", "next-page")),
    Response.json(hubSpotPage("2")),
  ];
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input): Promise<Response> => {
    requestedUrls.push(String(input));
    const response = responses.shift();
    if (response === undefined) throw new Error("Unexpected mocked request.");
    return response;
  };
  try {
    const deals = await getAllHubSpotDeals();
    assert.deepEqual(deals.map((deal) => deal.id), ["1", "2"]);
    assert.equal(requestedUrls.length, 4);
    assert.equal(new URL(requestedUrls[3] ?? "").searchParams.get("after"), "next-page");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HubSpot does not retry normal 4xx responses", async () => {
  let requests = 0;
  globalThis.fetch = async (): Promise<Response> => {
    requests += 1;
    return new Response(null, { status: 403, statusText: "Forbidden" });
  };
  try {
    await assert.rejects(getAllHubSpotDeals(), /HTTP 403 Forbidden/u);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
