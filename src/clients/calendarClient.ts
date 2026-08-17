import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { findEarliestFutureDealEvent } from "../calendarMatching.js";
import type { CalendarEventMetadata, DealCalendarEvent } from "../calendarMatching.js";

const CALENDAR_EVENTS_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
const CALENDAR_EVENTS_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ACCESS_TOKEN_SAFETY_WINDOW_MS = 60_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const MAX_RETRY_AFTER_MS = 10_000;

type OAuthClientFile = {
  installed?: { client_id?: unknown; client_secret?: unknown; token_uri?: unknown };
};

type OAuthTokenFile = {
  access_token?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
  expiry_date?: unknown;
};

type LoadedOAuth = {
  clientId: string;
  clientSecret: string;
  tokenUri: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiryDate: number | null;
};

type CalendarEventsPage = {
  items?: CalendarEventMetadata[];
  nextPageToken?: unknown;
};

let oauthPromise: Promise<LoadedOAuth> | null = null;
let cachedAccessToken: { value: string; expiryDate: number } | null = null;
let refreshPromise: Promise<string> | null = null;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function readJson(path: string, label: string): Promise<unknown> {
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
  const clientFile = await readJson("credentials/google-oauth-client.json", "Google OAuth client credentials") as OAuthClientFile;
  const tokenFile = await readJson("credentials/google-calendar-token.json", "Google Calendar OAuth token") as OAuthTokenFile;
  const clientId = nonEmptyString(clientFile.installed?.client_id);
  const clientSecret = nonEmptyString(clientFile.installed?.client_secret);
  if (clientId === null || clientSecret === null) {
    throw new Error("Google OAuth client credentials are missing required installed-client fields.");
  }
  const scopes = nonEmptyString(tokenFile.scope)?.split(/\s+/).filter(Boolean) ?? [];
  if (scopes.length !== 1 || scopes[0] !== CALENDAR_EVENTS_READONLY_SCOPE) {
    throw new Error("Google Calendar OAuth token must declare only calendar.events.readonly.");
  }
  return {
    clientId,
    clientSecret,
    tokenUri: nonEmptyString(clientFile.installed?.token_uri) ?? GOOGLE_TOKEN_ENDPOINT,
    accessToken: nonEmptyString(tokenFile.access_token),
    refreshToken: nonEmptyString(tokenFile.refresh_token),
    expiryDate: typeof tokenFile.expiry_date === "number" && Number.isFinite(tokenFile.expiry_date)
      ? tokenFile.expiry_date
      : null,
  };
}

async function getOAuth(): Promise<LoadedOAuth> {
  oauthPromise ??= loadOAuth();
  return oauthPromise;
}

async function refreshAccessToken(oauth: LoadedOAuth): Promise<string> {
  if (oauth.refreshToken === null) throw new Error("Calendar access token is expired and no refresh token exists.");
  let response: Response;
  try {
    response = await fetch(oauth.tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        refresh_token: oauth.refreshToken,
        grant_type: "refresh_token",
      }),
    });
  } catch {
    throw new Error("Google Calendar OAuth refresh failed before a response was received.");
  }
  if (!response.ok) throw new Error(`Google Calendar OAuth refresh failed with HTTP ${response.status} ${response.statusText}.`);
  const payload = await response.json() as { access_token?: unknown; scope?: unknown; expires_in?: unknown };
  const accessToken = nonEmptyString(payload.access_token);
  if (accessToken === null) throw new Error("Google Calendar OAuth refresh returned no access token.");
  const returnedScope = nonEmptyString(payload.scope);
  if (returnedScope !== null) {
    const scopes = returnedScope.split(/\s+/).filter(Boolean);
    if (scopes.length !== 1 || scopes[0] !== CALENDAR_EVENTS_READONLY_SCOPE) {
      throw new Error("Google Calendar OAuth refresh did not retain only calendar.events.readonly.");
    }
  }
  if (typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0) {
    throw new Error("Google Calendar OAuth refresh returned no valid expiry.");
  }
  cachedAccessToken = { value: accessToken, expiryDate: Date.now() + payload.expires_in * 1_000 };
  return accessToken;
}

async function refreshOnce(oauth: LoadedOAuth): Promise<string> {
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
  return refreshOnce(oauth);
}

async function refreshAfterUnauthorized(oauth: LoadedOAuth, rejectedToken: string): Promise<string> {
  if (cachedAccessToken?.value === rejectedToken) cachedAccessToken = null;
  if (cachedAccessToken !== null && cachedAccessToken.expiryDate > Date.now() + ACCESS_TOKEN_SAFETY_WINDOW_MS) {
    return cachedAccessToken.value;
  }
  return refreshOnce(oauth);
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("retry-after")?.trim();
  if (value === undefined || value === "") return null;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, MAX_RETRY_AFTER_MS) : null;
}

async function calendarGet(url: URL, oauth: LoadedOAuth): Promise<unknown> {
  let accessToken = await getAccessToken(oauth);
  let retriedUnauthorized = false;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      });
    } catch {
      throw new Error("Google Calendar request failed before a response was received.");
    }
    if (response.ok) return response.json() as Promise<unknown>;
    if (response.status === 401 && !retriedUnauthorized) {
      retriedUnauthorized = true;
      accessToken = await refreshAfterUnauthorized(oauth, accessToken);
      attempt -= 1;
      continue;
    }
    const retryable = response.status === 429 || response.status >= 500;
    const fallbackDelay = RETRY_DELAYS_MS[attempt];
    if (!retryable || fallbackDelay === undefined) {
      throw new Error(`Google Calendar events request failed with HTTP ${response.status} ${response.statusText}.`);
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, retryAfterMs(response) ?? fallbackDelay));
  }
  throw new Error("Google Calendar events request failed after bounded retries.");
}

export async function listFutureCalendarEvents(evaluationTime: string): Promise<CalendarEventMetadata[]> {
  const evaluationTimestamp = Date.parse(evaluationTime);
  if (!Number.isFinite(evaluationTimestamp)) throw new Error("Calendar evaluation time must be a valid timestamp.");
  const oauth = await getOAuth();
  const events: CalendarEventMetadata[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(CALENDAR_EVENTS_ENDPOINT);
    url.searchParams.set("timeMin", new Date(evaluationTimestamp).toISOString());
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("fields", "nextPageToken,items(id,summary,status,start(date,dateTime),end(date,dateTime))");
    if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
    const body = await calendarGet(url, oauth) as CalendarEventsPage;
    if (!Array.isArray(body.items) && body.items !== undefined) throw new Error("Google Calendar returned an unexpected events response shape.");
    events.push(...(body.items ?? []));
    pageToken = nonEmptyString(body.nextPageToken) ?? undefined;
  } while (pageToken !== undefined);
  return events;
}

export async function findNextCalendarEventForDeal(dealId: string, evaluationTime: string): Promise<DealCalendarEvent | null> {
  return findEarliestFutureDealEvent(dealId, await listFutureCalendarEvents(evaluationTime), evaluationTime);
}

export function resetCalendarAuthCacheForTesting(accessToken?: { value: string; expiryDate: number }): void {
  oauthPromise = null;
  cachedAccessToken = accessToken ?? null;
  refreshPromise = null;
}
