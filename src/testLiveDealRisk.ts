import assert from "node:assert/strict";

import { collectControlledLiveRisk } from "./liveRiskPipeline.js";
import type { RiskFlag } from "./types.js";

const EVALUATION_TIME = "2026-08-14T12:30:00+05:30";
const NORTHSTAR_MEETING_START = "2026-08-18T10:30:00.000Z";
const VERTEX_FLAGS: RiskFlag[] = [
  "NO_RECENT_SELLER_EMAIL",
  "NO_NEXT_MEETING",
  "MISSING_NEXT_STEP",
  "CLOSE_DATE_RISK",
  "STALE_DEAL",
];
async function main(): Promise<void> {
  const output = [];
  for (const { context, risk } of await collectControlledLiveRisk(EVALUATION_TIME)) {

    if (context.dealId === "341678981821") {
      assert.notEqual(context.lastSellerEmailAt, null, "Northstar must have seller-email evidence.");
      assert.equal(context.nextMeetingAt, NORTHSTAR_MEETING_START, "Northstar meeting fixture mismatch.");
      assert.equal(Boolean(context.nextStep?.trim()), true, "Northstar next step must be non-empty.");
      assert.equal(context.isClosed, false, "Northstar must be open.");
      assert.deepEqual(risk.flags, [], "Northstar must have no risk flags.");
      assert.equal(risk.severityScore, 0, "Northstar severity must be zero.");
    } else {
      assert.equal(context.lastSellerEmailAt, null, "Vertex must have no seller-email evidence.");
      assert.equal(context.nextMeetingAt, null, "Vertex must have no future meeting.");
      assert.equal(Boolean(context.nextStep?.trim()), false, "Vertex next step must be missing/blank.");
      assert.equal(context.isClosed, false, "Vertex must be open.");
      assert.deepEqual(risk.flags, VERTEX_FLAGS, "Vertex risk flags do not match the controlled fixture.");
      assert.equal(risk.severityScore, 1, "Vertex severity must be one.");
    }

    output.push({
      dealName: context.dealName,
      dealId: context.dealId,
      hasRecentSellerEmail: !risk.flags.includes("NO_RECENT_SELLER_EMAIL"),
      hasFutureMeeting: !risk.flags.includes("NO_NEXT_MEETING"),
      hasNextStep: Boolean(context.nextStep?.trim()),
      daysUntilClose: risk.daysUntilClose,
      flags: risk.flags.join(", "),
      severityScore: risk.severityScore,
    });
  }
  console.log("Sanitized controlled live deal risk results:");
  console.table(output);
}

main().catch((error: unknown) => {
  console.error(`Live deal risk test failed: ${error instanceof Error ? error.message : "Unknown error."}`);
  process.exitCode = 1;
});
