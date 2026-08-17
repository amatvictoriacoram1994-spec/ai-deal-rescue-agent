import type { SellerEmailRecord } from "./types.js";

export type SentEmailMetadata = {
  messageId: string;
  subject: string;
  from: string | null;
  sentAt: string;
};

const DEAL_MARKER_PATTERN = /\[HS-DEAL-([^\]\s]+)\]/g;

export function subjectHasExactDealId(subject: string, dealId: string): boolean {
  if (dealId.length === 0) return false;
  return subject.includes(`[HS-DEAL-${dealId}]`);
}

export function extractMatchedDealId(subject: string): string | null {
  DEAL_MARKER_PATTERN.lastIndex = 0;
  const match = DEAL_MARKER_PATTERN.exec(subject);
  return match?.[1] ?? null;
}

export function findLatestSellerEmail(
  dealId: string,
  messages: readonly SentEmailMetadata[],
): SellerEmailRecord | null {
  const matches = messages
    .filter((message) => subjectHasExactDealId(message.subject, dealId))
    .map((message) => ({ message, timestamp: Date.parse(message.sentAt) }));

  for (const match of matches) {
    if (!Number.isFinite(match.timestamp)) {
      throw new Error("Gmail metadata contains an invalid sentAt value.");
    }
  }

  const latest = matches.sort((left, right) => right.timestamp - left.timestamp)[0];
  if (latest === undefined) return null;

  return {
    dealId,
    messageId: latest.message.messageId,
    subject: latest.message.subject,
    sentAt: latest.message.sentAt,
  };
}
