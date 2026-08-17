import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRawDraftMessage,
  createGmailDraft,
  resetGmailDraftAuthCacheForTesting,
} from "./gmailDraftClient.js";
import type { GmailDraftInput, HumanDraftApproval } from "./gmailDraftClient.js";

const input: GmailDraftInput = { dealId: "vertex", to: "developer@example.com", subject: "Follow up", body: "Hello\n\nNext steps." };
const approval: HumanDraftApproval = { approved: true, approvedBy: "human", dealId: input.dealId };
const originalFetch = globalThis.fetch;

function prime(): void {
  resetGmailDraftAuthCacheForTesting({ value: "stored", expiryDate: Date.now() + 3_600_000 });
}

test("approved human request creates through only the users/me/drafts endpoint", async () => {
  prime();
  let requestedUrl = "";
  let requestBody = "";
  globalThis.fetch = async (request, init): Promise<Response> => {
    requestedUrl = String(request);
    requestBody = String(init?.body);
    return Response.json({ id: "draft-1" });
  };
  try {
    assert.deepEqual(await createGmailDraft(input, approval), { draftId: "draft-1" });
    assert.equal(new URL(requestedUrl).pathname, "/gmail/v1/users/me/drafts");
    assert.equal(requestedUrl.includes("send"), false);
    const parsed = JSON.parse(requestBody) as { message?: { raw?: unknown } };
    assert.equal(typeof parsed.message?.raw, "string");
  } finally {
    globalThis.fetch = originalFetch;
    resetGmailDraftAuthCacheForTesting();
  }
});

test("missing approval is rejected", async () => assert.rejects(createGmailDraft(input), /approval/u));
test("approved false is rejected", async () => assert.rejects(createGmailDraft(input, { approved: false, approvedBy: "human", dealId: "vertex" } as unknown as HumanDraftApproval), /approval/u));
test("non-human approval is rejected", async () => assert.rejects(createGmailDraft(input, { approved: true, approvedBy: "model", dealId: "vertex" } as unknown as HumanDraftApproval), /human/u));
test("approval deal ID mismatch is rejected", async () => assert.rejects(createGmailDraft(input, { ...approval, dealId: "other" }), /deal ID/u));
test("invalid recipient is rejected", () => assert.throws(() => buildRawDraftMessage({ ...input, to: "not-an-email" }), /recipient/u));
test("recipient and subject CRLF header injection are rejected", () => {
  assert.throws(() => buildRawDraftMessage({ ...input, to: "a@example.com\r\nBcc: attacker@example.com" }), /recipient/u);
  assert.throws(() => buildRawDraftMessage({ ...input, subject: "Hello\r\nBcc: attacker@example.com" }), /subject/u);
});
test("empty subject is rejected", () => assert.throws(() => buildRawDraftMessage({ ...input, subject: "  " }), /subject/u));
test("empty body is rejected", () => assert.throws(() => buildRawDraftMessage({ ...input, body: "\n " }), /body/u));
test("Deal Rescue subject is rejected", () => assert.throws(() => buildRawDraftMessage({ ...input, subject: "[Deal Rescue] Vertex" }), /forbidden/u));
test("stale deal content is rejected", () => assert.throws(() => buildRawDraftMessage({ ...input, body: "This is a stale deal." }), /forbidden/u));
test("close-date risk content is rejected", () => assert.throws(() => buildRawDraftMessage({ ...input, body: "There is close-date risk." }), /forbidden/u));
test("manager intervention content is rejected", () => assert.throws(() => buildRawDraftMessage({ ...input, body: "Manager intervention is required." }), /forbidden/u));
test("risk score and severity language are rejected", () => {
  assert.throws(() => buildRawDraftMessage({ ...input, body: "The risk score is high." }), /forbidden/u);
  assert.throws(() => buildRawDraftMessage({ ...input, body: "Severity is one." }), /forbidden/u);
});
test("CRM language is rejected", () => assert.throws(() => buildRawDraftMessage({ ...input, body: "We need to update CRM." }), /forbidden/u));
test("safe neutral subject and follow-up body are accepted", () => {
  assert.doesNotThrow(() => buildRawDraftMessage({
    ...input,
    subject: "Next steps for Vertex Systems platform upgrade",
    body: "Hi,\n\nWould you be available for a quick call this week to confirm the remaining decision points and timeline?\n\nBest,\nAbhishek",
  }));
});

test("401 permits one refresh and one retry", async () => {
  prime();
  let refreshes = 0;
  let draftRequests = 0;
  globalThis.fetch = async (request): Promise<Response> => {
    if (String(request).includes("oauth2.googleapis.com/token")) {
      refreshes += 1;
      return Response.json({ access_token: "refreshed", scope: "https://www.googleapis.com/auth/gmail.compose", expires_in: 3_600 });
    }
    draftRequests += 1;
    return draftRequests === 1 ? new Response(null, { status: 401 }) : Response.json({ id: "draft-401" });
  };
  try {
    assert.deepEqual(await createGmailDraft(input, approval), { draftId: "draft-401" });
    assert.equal(refreshes, 1);
    assert.equal(draftRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    resetGmailDraftAuthCacheForTesting();
  }
});

test("429 and 5xx retries are bounded", async () => {
  prime();
  let requests = 0;
  globalThis.fetch = async (): Promise<Response> => {
    requests += 1;
    return new Response(null, { status: requests === 1 ? 429 : 503, headers: { "Retry-After": "0" } });
  };
  try {
    await assert.rejects(createGmailDraft(input, approval), /HTTP 503/u);
    assert.equal(requests, 4);
  } finally {
    globalThis.fetch = originalFetch;
    resetGmailDraftAuthCacheForTesting();
  }
});
