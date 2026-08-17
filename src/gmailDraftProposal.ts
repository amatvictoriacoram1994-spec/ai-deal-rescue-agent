import type { ClaudeDealExplanation } from "./claudeContracts.js";
import type { GmailDraftInput } from "./clients/gmailDraftClient.js";

function customerFacingTopic(dealName: string): string {
  const [account, ...detailParts] = dealName.split(" - ");
  const detail = detailParts.join(" - ").trim();
  return detail.length === 0 ? dealName.trim() : `${account?.trim() ?? ""} ${detail.toLowerCase()}`.trim();
}

function customerFacingRequest(explanation: ClaudeDealExplanation): string {
  const flags = new Set(explanation.riskFlags);
  const needsMeeting = flags.has("NO_NEXT_MEETING");
  const needsNextStep = flags.has("MISSING_NEXT_STEP");
  const needsTimeline = flags.has("CLOSE_DATE_RISK");
  if (needsMeeting && needsNextStep) {
    return `Would you be available for a quick call this week to confirm the remaining decision points${needsTimeline ? " and timeline" : ""}? If there is anything you need from our side before then, I’m happy to send it over.`;
  }
  if (needsMeeting) return "Would you be available for a quick call this week to discuss next steps?";
  if (needsNextStep && needsTimeline) return "Could we confirm the remaining decision points and align on the timeline?";
  if (needsNextStep) return "Could you share your preferred next steps and anything you need from our side?";
  if (needsTimeline) return "Could we align on the timeline and any remaining items needed from our side?";
  return "I wanted to check in and see if there is anything you need from our side.";
}

export function buildGmailDraftProposal(explanation: ClaudeDealExplanation, to: string): GmailDraftInput | null {
  if (explanation.actionPriority === "none") return null;
  const topic = customerFacingTopic(explanation.dealName);
  return {
    dealId: explanation.dealId,
    to,
    subject: `Next steps for ${topic}`,
    body: [
      "Hi,",
      "",
      `I wanted to follow up on the next steps for ${topic}.`,
      "",
      customerFacingRequest(explanation),
      "",
      "Best,",
      "Abhishek",
    ].join("\n"),
  };
}
