import type { DealContext, DealRiskScore, RiskFlag } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const RECENT_EMAIL_WINDOW_MS = 7 * DAY_MS;

const SEVERITY_WEIGHTS: Readonly<Record<Exclude<RiskFlag, "STALE_DEAL">, number>> = {
  CLOSE_DATE_RISK: 0.4,
  NO_RECENT_SELLER_EMAIL: 0.25,
  NO_NEXT_MEETING: 0.2,
  MISSING_NEXT_STEP: 0.15,
};

function timestamp(value: string, fieldName: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be a valid date-time string.`);
  }
  return parsed;
}

function utcCalendarDay(value: number): number {
  const date = new Date(value);
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / DAY_MS);
}

export function scoreDeal(context: DealContext, evaluationTime: string): DealRiskScore {
  const evaluationMs = timestamp(evaluationTime, "evaluationTime");
  const emailMs = context.lastSellerEmailAt === null
    ? null
    : timestamp(context.lastSellerEmailAt, "lastSellerEmailAt");
  const closeMs = context.closeDate === null ? null : timestamp(context.closeDate, "closeDate");
  const meetingMs = context.nextMeetingAt === null
    ? null
    : timestamp(context.nextMeetingAt, "nextMeetingAt");

  const daysSinceLastSellerEmail = emailMs === null ? null : (evaluationMs - emailMs) / DAY_MS;
  const daysUntilClose = closeMs === null
    ? null
    : utcCalendarDay(closeMs) - utcCalendarDay(evaluationMs);

  if (context.isClosed) {
    return {
      dealId: context.dealId,
      dealName: context.dealName,
      flags: [],
      severityScore: 0,
      daysSinceLastSellerEmail,
      daysUntilClose,
    };
  }

  const noRecentSellerEmail = emailMs === null || evaluationMs - emailMs > RECENT_EMAIL_WINDOW_MS;
  const noNextMeeting = meetingMs === null
    || meetingMs < evaluationMs
    || (closeMs !== null && meetingMs > closeMs);
  const missingNextStep = context.nextStep === null || context.nextStep.trim().length === 0;
  const closeDateRisk = daysUntilClose !== null
    && (daysUntilClose < 0
      || (daysUntilClose <= 14 && (noNextMeeting || missingNextStep)));

  const flags: RiskFlag[] = [];
  if (noRecentSellerEmail) flags.push("NO_RECENT_SELLER_EMAIL");
  if (noNextMeeting) flags.push("NO_NEXT_MEETING");
  if (missingNextStep) flags.push("MISSING_NEXT_STEP");
  if (closeDateRisk) flags.push("CLOSE_DATE_RISK");
  if (noRecentSellerEmail && noNextMeeting) flags.push("STALE_DEAL");

  const severityScore = Math.min(1, flags.reduce((score, flag) => {
    return flag === "STALE_DEAL" ? score : score + SEVERITY_WEIGHTS[flag];
  }, 0));

  return {
    dealId: context.dealId,
    dealName: context.dealName,
    flags,
    severityScore,
    daysSinceLastSellerEmail,
    daysUntilClose,
  };
}
