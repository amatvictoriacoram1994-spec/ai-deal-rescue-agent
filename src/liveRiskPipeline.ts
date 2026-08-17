import { findNextCalendarEventForDeal } from "./clients/calendarClient.js";
import { findLatestSellerEmailForDeal } from "./clients/gmailClient.js";
import { getAllHubSpotDeals } from "./clients/hubspotClient.js";
import { buildDealContext } from "./dealContext.js";
import { scoreDeal } from "./scoring.js";
import type { DealContext, DealRiskScore } from "./types.js";

const CONTROLLED_DEALS = [
  { name: "Northstar Analytics - Expansion", id: "341678981821" },
  { name: "Vertex Systems - Platform Upgrade", id: "341673944815" },
] as const;

export type LiveRiskResult = { context: DealContext; risk: DealRiskScore };

export async function collectControlledLiveRisk(evaluationTime: string): Promise<LiveRiskResult[]> {
  const allDeals = await getAllHubSpotDeals();
  const results: LiveRiskResult[] = [];
  for (const expected of CONTROLLED_DEALS) {
    const deal = allDeals.find((candidate) => candidate.dealName === expected.name);
    if (deal === undefined) throw new Error(`Controlled HubSpot deal was not returned: ${expected.name}.`);
    if (deal.id !== expected.id) throw new Error(`Controlled deal ID mismatch for ${expected.name}.`);
    const sellerEmail = await findLatestSellerEmailForDeal(deal.id);
    const calendarMeeting = await findNextCalendarEventForDeal(deal.id, evaluationTime);
    const context = buildDealContext(deal, sellerEmail, calendarMeeting);
    results.push({ context, risk: scoreDeal(context, evaluationTime) });
  }
  return results;
}
