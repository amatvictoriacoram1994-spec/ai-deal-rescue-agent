import { getAllHubSpotDeals } from "./clients/hubspotClient.js";
import type { HubSpotDealRecord } from "./types.js";

const EXPECTED_DEALS = [
  { name: "Northstar Analytics - Expansion", amount: 18_000, closeDate: "2026-09-15" },
  { name: "Vertex Systems - Platform Upgrade", amount: 32_000, closeDate: "2026-08-25" },
] as const;

function normalizedDate(value: string | null): string | null {
  return value?.slice(0, 10) ?? null;
}

function verifyDeal(deals: HubSpotDealRecord[], expected: (typeof EXPECTED_DEALS)[number]): HubSpotDealRecord {
  const deal = deals.find((candidate) => candidate.dealName === expected.name);
  if (deal === undefined) throw new Error(`Expected deal was not returned: ${expected.name}`);
  if (deal.amount !== expected.amount) {
    throw new Error(`Amount mismatch for ${expected.name}: expected ${expected.amount}, received ${String(deal.amount)}.`);
  }
  if (normalizedDate(deal.closeDate) !== expected.closeDate) {
    throw new Error(`Close-date mismatch for ${expected.name}: expected ${expected.closeDate}, received ${String(deal.closeDate)}.`);
  }
  if (deal.isClosed) throw new Error(`Controlled fixture mismatch: ${expected.name} must be open.`);
  return deal;
}

async function main(): Promise<void> {
  const deals = await getAllHubSpotDeals();
  const targets = EXPECTED_DEALS.map((expected) => verifyDeal(deals, expected));

  console.log("Sanitized HubSpot deal summary:");
  console.table(targets.map((deal) => ({
    dealName: deal.dealName,
    amount: deal.amount,
    stageId: deal.stageId,
    pipelineId: deal.pipelineId,
    closeDate: deal.closeDate,
    nextStepState: deal.nextStep?.trim() ? "non-empty" : "missing/blank",
    isClosed: deal.isClosed,
  })));
  const [northstar, vertex] = targets;
  if (northstar === undefined || vertex === undefined) throw new Error("Controlled fixture targets were not resolved.");
  if (!northstar.nextStep?.trim()) {
    throw new Error("Controlled fixture mismatch: Northstar next step is missing/blank; expected non-empty.");
  }
  if (vertex.nextStep?.trim()) {
    throw new Error("Controlled fixture mismatch: Vertex next step is non-empty; expected missing/blank.");
  }
  console.log(`Verified ${EXPECTED_DEALS.length} expected deals out of ${deals.length} deals returned.`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown live-test failure.";
  console.error(`HubSpot live test failed: ${message}`);
  process.exitCode = 1;
});
