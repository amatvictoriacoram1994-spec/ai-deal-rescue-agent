import { findNextCalendarEventForDeal } from "./clients/calendarClient.js";
import { getAllHubSpotDeals } from "./clients/hubspotClient.js";

const EVALUATION_TIME = "2026-08-14T12:30:00+05:30";
const EXPECTED_START_AT = "2026-08-18T10:30:00.000Z";
const CONTROLLED_DEALS = [
  { name: "Northstar Analytics - Expansion", id: "341678981821", hasFutureMeeting: true },
  { name: "Vertex Systems - Platform Upgrade", id: "341673944815", hasFutureMeeting: false },
] as const;

async function main(): Promise<void> {
  const hubSpotDeals = await getAllHubSpotDeals();
  const results = [];
  for (const expected of CONTROLLED_DEALS) {
    const deal = hubSpotDeals.find((candidate) => candidate.dealName === expected.name);
    if (deal === undefined) throw new Error(`Controlled HubSpot deal was not returned: ${expected.name}.`);
    if (deal.id !== expected.id) throw new Error(`Controlled deal ID mismatch for ${expected.name}.`);
    const event = await findNextCalendarEventForDeal(deal.id, EVALUATION_TIME);
    const exactMarkerMatched = event?.summary.includes(`[HS-DEAL-${expected.id}]`) ?? false;
    if (expected.hasFutureMeeting) {
      if (event === null) throw new Error(`Controlled fixture mismatch: ${expected.name} has no future matching Calendar event.`);
      if (!exactMarkerMatched) throw new Error(`Controlled fixture mismatch: ${expected.name} lacks the exact Calendar marker.`);
      if (!Number.isFinite(Date.parse(event.startAt))) throw new Error(`Controlled fixture mismatch: ${expected.name} has an invalid meeting start.`);
      if (event.startAt !== EXPECTED_START_AT) {
        throw new Error(`Controlled fixture mismatch: ${expected.name} meeting start is ${event.startAt}; expected ${EXPECTED_START_AT}.`);
      }
    } else if (event !== null) {
      throw new Error(`Controlled fixture mismatch: ${expected.name} unexpectedly has a future matching Calendar event.`);
    }
    results.push({
      dealName: deal.dealName,
      dealId: deal.id,
      hasFutureMeeting: event !== null,
      startAt: event?.startAt ?? null,
      exactMarkerMatched,
    });
  }
  console.log("Sanitized controlled Calendar results:");
  console.table(results);
}

main().catch((error: unknown) => {
  console.error(`Calendar live test failed: ${error instanceof Error ? error.message : "Unknown error."}`);
  process.exitCode = 1;
});
