# hyperloop-teams-gateway

Microsoft Teams gateway for Implementation Spec approval, NEEDS_HUMAN escalation, and MR-ready notifications.

## Setup

```bash
npm install --prefix ../hyperloop-contracts && npm run build --prefix ../hyperloop-contracts
npm install
npm test
npm run build
npm run dev
```

## Notes

- Teams Gateway is **not** the workflow state owner.
- Verify Entra identity server-side (`x-hyperloop-entra-id` / Bot Framework claims); do not trust Adaptive Card payload fields alone.
- `POST /commands/approve` forwards to Control Plane `POST /workflows/:id/approve-spec`.

## M3 acceptance

- [x] Spec approval card includes immutable `specHash` + `expectedVersion`
- [x] Approve command requires verified Entra identity
- [x] Spoofed card `approver.entraId` is ignored

