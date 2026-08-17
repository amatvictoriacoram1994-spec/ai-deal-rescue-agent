export type HubSpotDealRecord = {
  id: string;
  dealName: string;
  amount: number | null;
  closeDate: string | null;
  pipelineId: string | null;
  stageId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  nextStep: string | null;
  isClosed: boolean;
};

export type DealContext = {
  dealId: string;
  dealName: string;
  amount: number | null;
  stageId: string | null;
  closeDate: string | null;
  isClosed: boolean;
  nextStep: string | null;
  lastSellerEmailAt: string | null;
  nextMeetingAt: string | null;
};

export type RiskFlag =
  | "NO_RECENT_SELLER_EMAIL"
  | "NO_NEXT_MEETING"
  | "MISSING_NEXT_STEP"
  | "CLOSE_DATE_RISK"
  | "STALE_DEAL";

export type DealRiskScore = {
  dealId: string;
  dealName: string;
  flags: RiskFlag[];
  severityScore: number;
  daysSinceLastSellerEmail: number | null;
  daysUntilClose: number | null;
};

export type SellerEmailRecord = {
  dealId: string;
  messageId: string;
  subject: string;
  sentAt: string;
};
