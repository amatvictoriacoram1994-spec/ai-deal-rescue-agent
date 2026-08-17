import {
  findLatestSellerEmailForDeal,
  getGmailApiRequestCount,
  resetGmailApiRequestCount,
} from "./clients/gmailClient.js";
import { getAllHubSpotDeals } from "./clients/hubspotClient.js";

const EXPECTED_DEALS = [
  { name: "Northstar Analytics - Expansion", id: "341678981821", hasMatchingEmail: true },
  { name: "Vertex Systems - Platform Upgrade", id: "341673944815", hasMatchingEmail: false },
] as const;

async function main(): Promise<void> {
  const deals = await getAllHubSpotDeals();
  const targets = EXPECTED_DEALS.map((expected) => {
    const deal = deals.find((candidate) => candidate.dealName === expected.name);
    if (deal === undefined) throw new Error(`Expected HubSpot deal was not returned: ${expected.name}`);
    if (deal.id !== expected.id) throw new Error(`Controlled deal ID mismatch for ${expected.name}.`);
    return { deal, expected };
  });

  resetGmailApiRequestCount();
  const results = [];
  for (const { deal, expected } of targets) {
    const email = await findLatestSellerEmailForDeal(deal.id);
    const lastSellerEmailAt = email?.sentAt ?? null;
    if (expected.hasMatchingEmail) {
      if (email === null || lastSellerEmailAt === null) {
        throw new Error(`Controlled fixture mismatch: ${deal.dealName} must have a matching seller email.`);
      }
      if (!email.subject.includes(`[HS-DEAL-${expected.id}]`)) {
        throw new Error(`Controlled fixture mismatch: ${deal.dealName} subject lacks its exact deal marker.`);
      }
    } else if (email !== null || lastSellerEmailAt !== null) {
      throw new Error(`Controlled fixture mismatch: ${deal.dealName} must have no matching seller email.`);
    }
    results.push({
      dealName: deal.dealName,
      dealId: deal.id,
      hasMatchingEmail: email !== null,
      matchedSubjectHasExactMarker: email?.subject.includes(`[HS-DEAL-${expected.id}]`) ?? false,
      lastSellerEmailAt,
    });
  }
  console.log("Sanitized targeted Gmail results:");
  console.table(results);
  console.log(`Gmail API requests made: ${getGmailApiRequestCount()}.`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown Gmail live-test failure.";
  console.error(`Gmail live test failed: ${message}`);
  process.exitCode = 1;
});
