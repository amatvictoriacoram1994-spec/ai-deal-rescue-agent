import type { DealContext, HubSpotDealRecord, SellerEmailRecord } from "./types.js";
import type { DealCalendarEvent } from "./calendarMatching.js";

export function buildDealContext(
  deal: HubSpotDealRecord,
  sellerEmail: SellerEmailRecord | null,
  calendarMeeting: DealCalendarEvent | null,
): DealContext {
  if (sellerEmail !== null && sellerEmail.dealId !== deal.id) {
    throw new Error("Seller email deal ID does not match the HubSpot deal ID.");
  }
  if (calendarMeeting !== null && calendarMeeting.dealId !== deal.id) {
    throw new Error("Calendar meeting deal ID does not match the HubSpot deal ID.");
  }

  return {
    dealId: deal.id,
    dealName: deal.dealName,
    amount: deal.amount,
    stageId: deal.stageId,
    closeDate: deal.closeDate,
    isClosed: deal.isClosed,
    nextStep: deal.nextStep,
    lastSellerEmailAt: sellerEmail?.sentAt ?? null,
    nextMeetingAt: calendarMeeting?.startAt ?? null,
  };
}
