import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
const GMAIL_DRAFTS_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ACCESS_TOKEN_SAFETY_WINDOW_MS = 60_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const MAX_RETRY_AFTER_MS = 10_000;

export type GmailDraftInput = { dealId: string; to: string; subject: string; body: string };
export type HumanDraftApproval = { approved: true; approvedBy: "human"; dealId: string };
export type GmailDraftResult = { draftId: string };

type OAuthClientFile = { installed?: { client_id?: unknown; client_secret?: unknown; token_uri?: unknown } };
type OAuthTokenFile = { access_token?: unknown; refresh_token?: unknown; scope?: unknown; expiry_date?: unknown };
type LoadedOAuth = { clientId: string; clientSecret: string; tokenUri: string; accessToken: string | null; refreshToken: string | null; expiryDate: number | null };

let oauthPromise: Promise<LoadedOAuth> | null = null;
let cachedAccessToken: { value: string; expiryDate: number } | null = null;
let refreshPromise: Promise<string> | null = null;

const FORBIDDEN_CUSTOMER_CONTENT = /deal\s+rescue|risk\s+score|severity|stale[_\s-]+deal|interven(?:e|tion)|manager|close[-\s]+date\s+risk|projected\s+close\s+date|days\s+until\s+close|\bcrm\b|risk\s+flag|recovery\s+actions?|deal\s+health|pipeline\s+risk|no_recent_seller_email|no_next_meeting|missing_next_step|close_date_risk|buyer\s+sentiment|customer\s+sentiment|\bwill\s+(?:definitely\s+)?(?:close|fail)\b/iu;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function validateDraft(input: GmailDraftInput): void {
  if (input.dealId.trim().length === 0 || input.dealId.length > 200) throw new Error("Draft dealId is invalid.");
  if (/[\r\n]/u.test(input.to) || input.to.length > 320 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(input.to)) {
    throw new Error("Draft recipient is invalid.");
  }
  if (input.subject.trim().length === 0 || input.subject.length > 200 || /[\r\n]/u.test(input.subject)) {
    throw new Error("Draft subject is invalid.");
  }
  if (input.body.trim().length === 0 || input.body.length > 20_000) throw new Error("Draft body is invalid.");
  if (FORBIDDEN_CUSTOMER_CONTENT.test(`${input.subject}\n${input.body}`)) {
    throw new Error("Draft contains forbidden internal customer-facing content.");
  }
}

function validateApproval(input: GmailDraftInput, approval: HumanDraftApproval | null | undefined): void {
  if (approval?.approved !== true) throw new Error("Explicit draft approval is required.");
  if (approval.approvedBy !== "human") throw new Error("Draft approval must come from a human.");
  if (approval.dealId !== input.dealId) throw new Error("Draft approval deal ID does not match the draft deal ID.");
}

export function buildRawDraftMessage(input: GmailDraftInput): string {
  validateDraft(input);
  const encodedSubject = Buffer.from(input.subject, "utf8").toString("base64");
  const normalizedBody = input.body.replace(/\r?\n/gu, "\r\n");
  const mime = [
    `To: ${input.to}`,
    `Subject: =?UTF-8?B?${encodedSubject}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    normalizedBody,
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

async function readJson(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(resolve(process.cwd(), path), "utf8")) as unknown;
  } catch {
    throw new Error(`Unable to read valid ${label}.`);
  }
}

async function loadOAuth(): Promise<LoadedOAuth> {
  const client = await readJson("credentials/google-oauth-client.json", "Google OAuth client") as OAuthClientFile;
  const token = await readJson("credentials/google-gmail-compose-token.json", "Gmail Compose OAuth token") as OAuthTokenFile;
  const clientId = nonEmptyString(client.installed?.client_id);
  const clientSecret = nonEmptyString(client.installed?.client_secret);
  if (clientId === null || clientSecret === null) throw new Error("Google OAuth installed client is missing required fields.");
  const scopes = nonEmptyString(token.scope)?.split(/\s+/).filter(Boolean) ?? [];
  if (scopes.length !== 1 || scopes[0] !== GMAIL_COMPOSE_SCOPE) throw new Error("Gmail Compose token must contain only gmail.compose.");
  return {
    clientId,
    clientSecret,
    tokenUri: nonEmptyString(client.installed?.token_uri) ?? GOOGLE_TOKEN_ENDPOINT,
    accessToken: nonEmptyString(token.access_token),
    refreshToken: nonEmptyString(token.refresh_token),
    expiryDate: typeof token.expiry_date === "number" && Number.isFinite(token.expiry_date) ? token.expiry_date : null,
  };
}

async function getOAuth(): Promise<LoadedOAuth> {
  oauthPromise ??= loadOAuth();
  return oauthPromise;
}

async function refreshAccessToken(oauth: LoadedOAuth): Promise<string> {
  if (oauth.refreshToken === null) throw new Error("Gmail Compose token is expired and no refresh token exists.");
  let response: Response;
  try {
    response = await fetch(oauth.tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: oauth.clientId, client_secret: oauth.clientSecret, refresh_token: oauth.refreshToken, grant_type: "refresh_token" }),
    });
  } catch {
    throw new Error("Gmail Compose OAuth refresh failed before a response was received.");
  }
  if (!response.ok) throw new Error(`Gmail Compose OAuth refresh failed with HTTP ${response.status} ${response.statusText}.`);
  const payload = await response.json() as { access_token?: unknown; scope?: unknown; expires_in?: unknown };
  const accessToken = nonEmptyString(payload.access_token);
  if (accessToken === null) throw new Error("Gmail Compose OAuth refresh returned no access token.");
  const returnedScope = nonEmptyString(payload.scope);
  if (returnedScope !== null && returnedScope !== GMAIL_COMPOSE_SCOPE) throw new Error("Gmail Compose OAuth refresh returned an unexpected scope.");
  if (typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0) throw new Error("Gmail Compose OAuth refresh returned no valid expiry.");
  cachedAccessToken = { value: accessToken, expiryDate: Date.now() + payload.expires_in * 1_000 };
  return accessToken;
}

async function refreshOnce(oauth: LoadedOAuth): Promise<string> {
  refreshPromise ??= refreshAccessToken(oauth).finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function getAccessToken(oauth: LoadedOAuth): Promise<string> {
  if (cachedAccessToken !== null && cachedAccessToken.expiryDate > Date.now() + ACCESS_TOKEN_SAFETY_WINDOW_MS) return cachedAccessToken.value;
  if (oauth.accessToken !== null && oauth.expiryDate !== null && oauth.expiryDate > Date.now() + ACCESS_TOKEN_SAFETY_WINDOW_MS) {
    cachedAccessToken = { value: oauth.accessToken, expiryDate: oauth.expiryDate };
    return oauth.accessToken;
  }
  return refreshOnce(oauth);
}

async function refreshAfter401(oauth: LoadedOAuth, rejectedToken: string): Promise<string> {
  if (cachedAccessToken?.value === rejectedToken) cachedAccessToken = null;
  if (cachedAccessToken !== null && cachedAccessToken.expiryDate > Date.now() + ACCESS_TOKEN_SAFETY_WINDOW_MS) return cachedAccessToken.value;
  return refreshOnce(oauth);
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return null;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, MAX_RETRY_AFTER_MS) : null;
}

export async function createGmailDraft(input: GmailDraftInput, approval?: HumanDraftApproval | null): Promise<GmailDraftResult> {
  validateApproval(input, approval);
  const raw = buildRawDraftMessage(input);
  const oauth = await getOAuth();
  let accessToken = await getAccessToken(oauth);
  let retried401 = false;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(GMAIL_DRAFTS_ENDPOINT, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ message: { raw } }),
      });
    } catch {
      throw new Error("Gmail draft creation failed before a response was received.");
    }
    if (response.ok) {
      const result = await response.json() as { id?: unknown };
      const draftId = nonEmptyString(result.id);
      if (draftId === null) throw new Error("Gmail draft creation returned no draft ID.");
      return { draftId };
    }
    if (response.status === 401 && !retried401) {
      retried401 = true;
      accessToken = await refreshAfter401(oauth, accessToken);
      attempt -= 1;
      continue;
    }
    const delay = RETRY_DELAYS_MS[attempt];
    if ((response.status !== 429 && response.status < 500) || delay === undefined) {
      throw new Error(`Gmail draft creation failed with HTTP ${response.status} ${response.statusText}.`);
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, retryAfterMs(response) ?? delay));
  }
  throw new Error("Gmail draft creation failed after bounded retries.");
}

export function resetGmailDraftAuthCacheForTesting(accessToken?: { value: string; expiryDate: number }): void {
  oauthPromise = null;
  cachedAccessToken = accessToken ?? null;
  refreshPromise = null;
}
