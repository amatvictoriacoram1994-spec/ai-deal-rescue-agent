# AI Deal Rescue Agent

AI Deal Rescue Agent is a portfolio project for a human-controlled workflow that helps sellers identify at-risk deals and decide what to do next.

## Current scope: Phase 3

Phase 1 established read-only HubSpot deal access. Phase 2 adds a deterministic deal-risk engine with fixture-only seller-email and meeting context. Risk flags and severity are calculated entirely in code from an explicitly injected evaluation time.

Phase 3 adds read-only Gmail sent-message metadata access and deterministic matching through exact subject markers in the form `[HS-DEAL-<HubSpotDealId>]`. Gmail is queried separately for each known HubSpot deal ID using the `SENT` label and a targeted subject search; the mailbox is never crawled wholesale. The integration reads only matching message IDs, Subject and From headers, and Gmail's internal timestamp; it does not fetch or store message bodies. Gmail matches populate `lastSellerEmailAt`, while `nextMeetingAt` remains null until a future Calendar phase.

The live integration remains limited to loading a locally stored HubSpot Service Key, reading deals from HubSpot's official API, normalizing the required fields, and verifying two known deals. It does not modify HubSpot records. The credential file is local-only and excluded from version control.

## Run the checks

Use Node.js 20 or newer. Ensure `credentials/hubspot.json` exists with a non-empty `serviceKey`, then run:

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test:scoring
npm.cmd run test:gmail
npm.cmd run test:hubspot-live
npm.cmd run test:gmail-live
```

Live tests print only explicitly sanitized HubSpot fields or Gmail subject, timestamp, and matched deal ID. They never print credentials, authorization headers, email bodies, or recipient addresses.

## Future architecture

Later phases may combine HubSpot deals, Gmail seller communication, and Google Calendar meetings into canonical deal context. Deterministic risk rules may then produce a ranked rescue queue, with an AI-generated recommended next action, explicit human approval, and Gmail draft creation.

None of those later integrations or AI explanation features are implemented yet. The system performs no autonomous sends and no autonomous CRM stage changes. It does not generate or claim fake business metrics. Future AI components may explain deterministic scoring results, but they will not decide whether a deal is risky.
