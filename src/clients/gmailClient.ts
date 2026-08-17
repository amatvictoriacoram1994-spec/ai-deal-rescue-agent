import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { SentEmailMetadata } from "../gmailMatching.js";
import { findLatestSellerEmail } from "../gmailMatching.js";
import type { SellerEmailRecord } from "../types.js";

const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_MESSAGES_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TARGETED_MAX_RESULTS = 50;
let gmailApiRequestCount = 0;
const ACCESS_TOKEN_SAFETY_WINDOW_MS = 60_000;
let oauthPromise: Promise<LoadedOAuth> | null = null;
let cachedAccessToken: { value: string; expiryDate: number } | null = null;
let refreshPromise: Promise<string> | null = null;

type OAuthClientContainer = {
  client_id?: unknown;
  client_secret?: unknown;
  token_uri?: unknown;
};

type OAuthClientFile = {
  installed?: OAuthClientContainer;
  web?: OAuthClientContainer;
};

type OAuthTokenFile = {
  access_token?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
  expiry_date?: unknown;
};

type MessageListPage = {
  messages?: Array<{ id?: unknown }>;
  nextPageToken?: unknown;
};

type MessageMetadataResponse = {
  id?: unknown;
  internalDate?: unknown;
  payload?: {
    headers?: Array<{ name?: unknown; value?: unknown }>;
  };
};

type LoadedOAuth = {
  clientId: string;
  clientSecret: string;
  tokenUri: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiryDate: number | null;
  scopes: string[];
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function readJsonFile(path: string, label: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(resolve(process.cwd(), path), "utf8");
  } catch {
    throw new Error(`Unable to read ${label}.`);
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

async function loadOAuth(): Promise<LoadedOAuth> {
  const clientFile = await readJsonFile("credentials/google-oauth-client.json", "Google OAuth client credentials");
  const tokenFile = await readJsonFile("credentials/google-oauth-token.json", "Google OAuth token credentials");
  const clientCandidate = clientFile as OAuthClientFile;
  const client = clientCandidate.installed ?? clientCandidate.web;
  const token = tokenFile as OAuthTokenFile;

  const clientId = nonEmptyString(client?.client_id);
  const clientSecret = nonEmptyString(client?.client_secret);
  const tokenUri = nonEmptyString(client?.token_uri) ?? GOOGLE_TOKEN_ENDPOINT;
  const declaredScope = nonEmptyString(token.scope);
  const scopes = declaredScope?.split(/\s+/).filter(Boolean) ?? [];

  if (clientId === null || clientSecret === null) {
    throw new Error("Google OAuth client credentials are missing required fields.");
  }
  if (scopes.length !== 1 || scopes[0] !== GMAIL_READONLY_SCOPE) {
    throw new Error("Google OAuth token must declare only the required gmail.readonly scope.");
  }
  const expiryDate = typeof token.expiry_date === "number" && Number.isFinite(token.expiry_date)
    ? token.expiry_date
    : null;

  return {
    clientId,
    clientSecret,
    tokenUri,
    accessToken: nonEmptyString(token.access_token),
    refreshToken: nonEmptyString(token.refresh_token),
    expiryDate,
    scopes,
  };
}

async function refreshAccessToken(oauth: LoadedOAuth): Promise<string> {
  if (oauth.refreshToken === null) {
    throw new Error("Google OAuth access token is unavailable or expired and no refresh token exists.");
  }
  const body = new URLSearchParams({
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    refresh_token: oauth.refreshToken,
    grant_type: "refresh_token",
  });

  let response: Response;
  try {
    response = await fetch(oauth.tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    throw new Error("Google OAuth token refresh failed before a response was received.");
  }
  if (!response.ok) {
    throw new Error(`Google OAuth token refresh failed with HTTP ${response.status} ${response.statusText}.`);
  }
  const payload = await response.json() as { access_token?: unknown; scope?: unknown; expires_in?: unknown };
  const accessToken = nonEmptyString(payload.access_token);
  if (accessToken === null) {
    throw new Error("Google OAuth token refresh returned no access token.");
  }
  const returnedScope = nonEmptyString(payload.scope);
  if (returnedScope !== null) {
    const returnedScopes = returnedScope.split(/\s+/).filter(Boolean);
    if (returnedScopes.length !== 1 || returnedScopes[0] !== GMAIL_READONLY_SCOPE) {
      throw new Error("Google OAuth token refresh did not retain only the required gmail.readonly scope.");
    }
  }
  if (typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0) {
    throw new Error("Google OAuth token refresh returned no valid expiry.");
  }
  cachedAccessToken = { value: accessToken, expiryDate: Date.now() + payload.expires_in * 1_000 };
  return accessToken;
}

async function getOAuth(): Promise<LoadedOAuth> {
  oauthPromise ??= loadOAuth();
  return oauthPromise;
}

async function refreshAccessTokenOnce(oauth: LoadedOAuth): Promise<string> {
  refreshPromise ??= refreshAccessToken(oauth).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function getAccessToken(oauth: LoadedOAuth): Promise<string> {
  if (cachedAccessToken !== null && cachedAccessToken.expiryDate > Date.now() + ACCESS_TOKEN_SAFETY_WINDOW_MS) {
    return cachedAccessToken.value;
  }
  if (oauth.accessToken !== null && oauth.expiryDate !== null && oauth.expiryDate > Date.now() + ACCESS_TOKEN_SAFETY_WINDOW_MS) {
    cachedAccessToken = { value: oauth.accessToken, expiryDate: oauth.expiryDate };
    return oauth.accessToken;
  }
  return refreshAccessTokenOnce(oauth);
}

async function refreshAfterUnauthorized(oauth: LoadedOAuth, rejectedToken: string): Promise<string> {
  if (cachedAccessToken?.value === rejectedToken) cachedAccessToken = null;
  if (cachedAccessToken !== null && cachedAccessToken.expiryDate > Date.now() + ACCESS_TOKEN_SAFETY_WINDOW_MS) {
    return cachedAccessToken.value;
  }
  return refreshAccessTokenOnce(oauth);
}

type GmailOperation = {
  name: "list targeted sent messages" | "get sent message metadata";
  messageId?: string;
};

async function gmailGet(url: URL, oauth: LoadedOAuth, operation: GmailOperation): Promise<unknown> {
  const retryDelaysMs = [1_000, 2_000, 4_000];
  let response: Response | undefined;
  let accessToken = await getAccessToken(oauth);
  let retriedUnauthorized = false;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      gmailApiRequestCount += 1;
      response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      });
    } catch {
      throw new Error("Gmail request failed before a response was received.");
    }
    if (response.ok) break;
    if (response.status === 401 && !retriedUnauthorized) {
      retriedUnauthorized = true;
      accessToken = await refreshAfterUnauthorized(oauth, accessToken);
      attempt -= 1;
      continue;
    }
    const retryable = response.status === 429 || response.status >= 500;
    const delay = retryDelaysMs[attempt];
    if (!retryable || delay === undefined) {
      const messageSuffix = operation.messageId === undefined ? "" : `; message ID ${operation.messageId}`;
      throw new Error(`${operation.name} failed with HTTP ${response.status}${messageSuffix}.`);
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delay));
  }
  if (response === undefined || !response.ok) throw new Error("Gmail request failed after bounded retries.");
  try {
    return await response.json() as unknown;
  } catch {
    throw new Error("Gmail returned a non-JSON response.");
  }
}

function headerValue(message: MessageMetadataResponse, name: string): string | null {
  const header = message.payload?.headers?.find((candidate) => {
    return typeof candidate.name === "string" && candidate.name.toLowerCase() === name.toLowerCase();
  });
  return nonEmptyString(header?.value);
}

async function getSentMessageMetadata(messageId: string, oauth: LoadedOAuth): Promise<SentEmailMetadata> {
  const url = new URL(`${GMAIL_MESSAGES_ENDPOINT}/${encodeURIComponent(messageId)}`);
  url.searchParams.set("format", "metadata");
  url.searchParams.append("metadataHeaders", "Subject");
  url.searchParams.append("metadataHeaders", "From");
  const body = await gmailGet(url, oauth, {
    name: "get sent message metadata",
    messageId,
  }) as MessageMetadataResponse;
  const id = nonEmptyString(body.id);
  const internalDate = nonEmptyString(body.internalDate);
  if (id === null || internalDate === null || !/^\d+$/.test(internalDate)) {
    throw new Error("Gmail returned an unexpected message metadata shape.");
  }
  const timestamp = Number(internalDate);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Gmail returned an invalid internalDate.");
  }
  return {
    messageId: id,
    subject: headerValue(body, "Subject") ?? "",
    from: headerValue(body, "From"),
    sentAt: new Date(timestamp).toISOString(),
  };
}

export function buildTargetedDealSearchQuery(dealId: string): string {
  if (dealId.trim().length === 0 || /[\r\n"]/u.test(dealId)) {
    throw new Error("HubSpot deal ID is not valid for a Gmail subject query.");
  }
  return `subject:"[HS-DEAL-${dealId}]"`;
}

export async function findLatestSellerEmailForDeal(dealId: string): Promise<SellerEmailRecord | null> {
  const oauth = await getOAuth();
  const messageIds: string[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(GMAIL_MESSAGES_ENDPOINT);
    url.searchParams.set("labelIds", "SENT");
    url.searchParams.set("q", buildTargetedDealSearchQuery(dealId));
    url.searchParams.set("maxResults", String(TARGETED_MAX_RESULTS));
    if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
    const body = await gmailGet(url, oauth, { name: "list targeted sent messages" }) as MessageListPage;
    for (const message of body.messages ?? []) {
      const id = nonEmptyString(message.id);
      if (id === null) throw new Error("Gmail returned a sent-message entry without a valid ID.");
      messageIds.push(id);
    }
    pageToken = nonEmptyString(body.nextPageToken) ?? undefined;
  } while (pageToken !== undefined);

  const messages: SentEmailMetadata[] = [];
  for (const messageId of messageIds) {
    messages.push(await getSentMessageMetadata(messageId, oauth));
  }
  return findLatestSellerEmail(dealId, messages);
}

export function getConfiguredGmailScopes(): Promise<string[]> {
  return getOAuth().then((oauth) => [...oauth.scopes]);
}

export function resetGmailAuthCacheForTesting(accessToken?: { value: string; expiryDate: number }): void {
  oauthPromise = null;
  cachedAccessToken = accessToken ?? null;
  refreshPromise = null;
}

export function resetGmailApiRequestCount(): void {
  gmailApiRequestCount = 0;
}

export function getGmailApiRequestCount(): number {
  return gmailApiRequestCount;
}
