import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { HubSpotDealRecord } from "../types.js";

export const HUBSPOT_DEALS_ENDPOINT = "https://api.hubapi.com/crm/objects/2026-03/deals";
const DEAL_PROPERTIES = [
  "dealname",
  "amount",
  "closedate",
  "pipeline",
  "dealstage",
  "createdate",
  "hs_lastmodifieddate",
  "hs_next_step",
  "hs_is_closed",
] as const;
const MAX_REQUEST_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [250, 500] as const;
const MAX_RETRY_AFTER_MS = 10_000;

type HubSpotDealProperties = Partial<Record<(typeof DEAL_PROPERTIES)[number], string | null>>;
type HubSpotDeal = { id: string; properties?: HubSpotDealProperties };
type HubSpotPage = {
  results: HubSpotDeal[];
  paging?: { next?: { after?: string } };
};

function nullableString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseAmount(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    throw new Error("HubSpot returned a deal with a non-numeric amount.");
  }
  return amount;
}

function parseIsClosed(value: string | null | undefined): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("HubSpot returned a deal without a valid hs_is_closed value.");
}

function normalizeDeal(deal: HubSpotDeal): HubSpotDealRecord {
  if (typeof deal.id !== "string" || deal.id.length === 0) {
    throw new Error("HubSpot returned a deal without a valid ID.");
  }
  const properties = deal.properties ?? {};
  return {
    id: deal.id,
    dealName: nullableString(properties.dealname) ?? "",
    amount: parseAmount(properties.amount),
    closeDate: nullableString(properties.closedate),
    pipelineId: nullableString(properties.pipeline),
    stageId: nullableString(properties.dealstage),
    createdAt: nullableString(properties.createdate),
    updatedAt: nullableString(properties.hs_lastmodifieddate),
    nextStep: nullableString(properties.hs_next_step),
    isClosed: parseIsClosed(properties.hs_is_closed),
  };
}

async function loadServiceKey(): Promise<string> {
  const credentialPath = resolve(process.cwd(), "credentials", "hubspot.json");
  let contents: string;
  try {
    contents = await readFile(credentialPath, "utf8");
  } catch {
    throw new Error("Unable to read credentials/hubspot.json.");
  }

  let credentials: { serviceKey?: unknown };
  try {
    credentials = JSON.parse(contents) as { serviceKey?: unknown };
  } catch {
    throw new Error("credentials/hubspot.json is not valid JSON.");
  }
  if (typeof credentials.serviceKey !== "string" || credentials.serviceKey.trim().length === 0) {
    throw new Error("credentials/hubspot.json must contain a non-empty serviceKey.");
  }
  return credentials.serviceKey.trim();
}

function isHubSpotPage(value: unknown): value is HubSpotPage {
  return typeof value === "object" && value !== null && Array.isArray((value as { results?: unknown }).results);
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("retry-after")?.trim();
  if (value === undefined || value === "") return null;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, MAX_RETRY_AFTER_MS) : null;
}

async function fetchHubSpotPage(url: URL, serviceKey: string): Promise<Response> {
  for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${serviceKey}` },
      });
    } catch {
      throw new Error("HubSpot request failed before a response was received.");
    }
    if (response.ok) return response;
    const transient = response.status === 429 || response.status >= 500;
    const fallbackDelay = RETRY_DELAYS_MS[attempt];
    if (!transient || fallbackDelay === undefined) {
      throw new Error(`HubSpot deals request failed with HTTP ${response.status} ${response.statusText}.`);
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, retryAfterMs(response) ?? fallbackDelay));
  }
  throw new Error("HubSpot deals request failed after bounded retries.");
}

export async function getAllHubSpotDeals(): Promise<HubSpotDealRecord[]> {
  const serviceKey = await loadServiceKey();
  const deals: HubSpotDealRecord[] = [];
  let after: string | undefined;

  do {
    const url = new URL(HUBSPOT_DEALS_ENDPOINT);
    url.searchParams.set("limit", "100");
    url.searchParams.set("archived", "false");
    url.searchParams.set("properties", DEAL_PROPERTIES.join(","));
    if (after !== undefined) url.searchParams.set("after", after);

    const response = await fetchHubSpotPage(url, serviceKey);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("HubSpot returned a non-JSON deals response.");
    }
    if (!isHubSpotPage(body)) {
      throw new Error("HubSpot returned an unexpected deals response shape.");
    }

    deals.push(...body.results.map(normalizeDeal));
    after = body.paging?.next?.after;
  } while (after !== undefined);

  return deals;
}
