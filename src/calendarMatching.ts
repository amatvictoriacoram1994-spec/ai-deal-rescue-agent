export type CalendarEventMetadata = {
  id?: unknown;
  summary?: unknown;
  status?: unknown;
  start?: { dateTime?: unknown; date?: unknown };
  end?: { dateTime?: unknown; date?: unknown };
};

export type DealCalendarEvent = {
  dealId: string;
  eventId: string;
  summary: string;
  startAt: string;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizedStart(event: CalendarEventMetadata): string | null {
  const dateTime = nonEmptyString(event.start?.dateTime);
  const date = nonEmptyString(event.start?.date);
  const candidate = dateTime ?? (date !== null && /^\d{4}-\d{2}-\d{2}$/u.test(date) ? `${date}T00:00:00.000Z` : null);
  if (candidate === null) return null;
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function calendarSummaryHasExactDealId(summary: string, dealId: string): boolean {
  return summary.includes(`[HS-DEAL-${dealId}]`);
}

export function findEarliestFutureDealEvent(
  dealId: string,
  events: readonly CalendarEventMetadata[],
  evaluationTime: string,
): DealCalendarEvent | null {
  const evaluationTimestamp = Date.parse(evaluationTime);
  if (!Number.isFinite(evaluationTimestamp)) throw new Error("Calendar evaluation time must be a valid timestamp.");

  let earliest: DealCalendarEvent | null = null;
  let earliestTimestamp = Number.POSITIVE_INFINITY;
  for (const event of events) {
    if (event.status === "cancelled") continue;
    const eventId = nonEmptyString(event.id);
    const summary = nonEmptyString(event.summary);
    const startAt = normalizedStart(event);
    if (eventId === null || summary === null || startAt === null) continue;
    if (!calendarSummaryHasExactDealId(summary, dealId)) continue;
    const startTimestamp = Date.parse(startAt);
    if (startTimestamp <= evaluationTimestamp || startTimestamp >= earliestTimestamp) continue;
    earliestTimestamp = startTimestamp;
    earliest = { dealId, eventId, summary, startAt };
  }
  return earliest;
}
