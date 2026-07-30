# babylog as a freemium SaaS on 32b.io — design

Date: 2026-07-30
Status: approved (brainstorming session)

## Goal

Turn babylog from a single-household, Access-gated personal deployment into a
self-service, billable product able to serve thousands of households, while
keeping the existing Worker + single-D1 architecture and all three surfaces
(web PWA, MCP, Alexa).

## Decisions already made

- **Auth**: reuse the existing self-built 32b.io magic-link auth (`~/ws/32b`):
  HMAC-signed `sess` cookie, `Domain=32b.io`, SES login emails, self-service
  (anyone may log in). No Cloudflare Access, no managed auth vendor.
- **Billing**: Stripe (Checkout + Billing customer portal + webhooks), with
  Stripe Tax enabled from day one.
- **Pricing**: freemium. Free = 1 baby, web app, 2 caregivers. Premium
  (~€3–5/mo, per household) = Alexa, MCP/AI, indications engine, unlimited
  caregivers/babies, report exports (CSV/PDF). (GDPR JSON takeout is free for
  every account — see §7.)
- **Data layer**: unchanged. One Worker, one D1, existing household tenancy.

## Non-goals

- No rearchitecture of the data layer (no per-tenant DBs, no sharding).
- No mobile app / app-store distribution in this phase (possible later growth
  channel; the PWA stands in).
- No managed auth provider.

## 1. Topology & identity

- The babylog Worker moves to **`baby.32b.io`** (route on the 32b.io zone;
  `workers_dev` stays disabled).
- `src/access.ts` (Cloudflare Access JWT verification) is replaced by a
  verifier for the 32b.io `sess` cookie: same HMAC-SHA256
  `b64u(payload).b64u(sig)` scheme, sharing `SESSION_SECRET` as a Worker
  secret. Identity remains an email, which matches the existing `users.email`
  tenancy key — the current household migrates with zero data changes.
- Unauthenticated page requests 302 to `https://www.32b.io/login?next=<url>`
  (the pattern the srr.32b.io proxy already uses); unauthenticated API/MCP
  requests get a JSON 401.

## 2. Onboarding & caregiver invites (replaces the Access allowlist)

- Keep the existing guarantee: **no silent household provisioning** (it would
  split one family into two tenants).
- A logged-in email with no `users` row sees an onboarding screen with exactly
  two paths: **create a new household** or **accept a pending invite**.
- Invites: the household owner enters an email (existing `add_caregiver`
  flow). A magic-link login is itself proof of email ownership, so the invite
  is claimable the moment that email logs in. The onboarding screen surfaces
  pending invites for the logged-in email; accepting one joins the household
  instead of creating a new one.
- The Cloudflare Access policy allowlist disappears entirely; membership is
  purely DB state.

## 3. OAuth authorization server (Alexa + MCP)

- Magic-link cookies don't speak OAuth, but Alexa account linking and remote
  MCP clients both require an OAuth2 authorization server.
- Add a thin AS using Cloudflare's `workers-oauth-provider` library (OAuth
  2.1, PKCE, dynamic client registration — built for the remote-MCP case).
  Its "login page" is the existing sess-cookie gate plus a minimal consent
  screen; identity flows from the same cookie.
- One AS serves both Alexa account linking and MCP OAuth. Tokens map to the
  same email identity → same tenant resolution.
- Public Alexa availability additionally requires Amazon skill certification
  (process work, not code).

## 4. Billing & entitlements (Stripe, freemium)

- Bill **per household**; the owner subscribes via Stripe Checkout and manages
  the subscription via the hosted customer portal.
- New D1 table `subscriptions`:
  `household_id → stripe_customer_id, plan, status, current_period_end`.
  Written **only** by the Stripe webhook handler (checkout completed,
  subscription updated/deleted, payment failed).
- Tenant middleware attaches the effective plan to the resolved tenant; gates
  are enforced **server-side** on every surface (web, API, MCP, Alexa), not
  just hidden in the UI.
- Free tier limits: 1 baby, 2 caregivers, web only. Premium unlocks Alexa,
  MCP, indications, unlimited caregivers/babies, report exports (CSV/PDF).
- Stripe Tax enabled from day one (B2C digital sales from Spain owe VAT in
  each customer's country; Stripe Tax computes/collects, filing remains ours
  or via Stripe's partners).

## 5. Auth hardening (changes in ~/ws/32b, inherited by all 32b.io services)

Required before the auth fronts paying customers' baby data:

1. **Session expiry**: sess tokens carry an expiry with sliding renewal
   (today they never expire).
2. **Per-user revocation**: a small session-id registry (KV) enabling
   "log out everywhere" and account bans, replacing
   rotate-`SESSION_SECRET`-logs-everyone-out as the only lever.
3. **Stable user ids** in tokens (eventually), instead of raw emails.

## 6. Scale & operations

- Single D1 stays: thousands of households fit comfortably within D1 limits
  and the paid Workers plan's included quotas. No schema rearchitecture.
- **Staging environment**: a staging Worker + staging D1; CI migrates staging
  before prod (today CI migrates prod directly).
- **Backups**: nightly D1 export to R2 (Time Travel only covers 30 days).
- **Rate limiting**: per-tenant limits on write endpoints (zone rules and/or
  in-Worker checks).
- **Alerting** on error rates (observability is already enabled).

## 7. Legal & product floor

- Privacy policy + Terms of Service.
- Working **account deletion** (full-household erase — generalize the
  `removeBaby` cascade) and **JSON data export**, both available to every
  account regardless of plan (the premium "export" is convenience reports,
  not the GDPR takeout). Baby health data is GDPR-sensitive; both must
  genuinely work before the first paying stranger signs up.
- A support contact email.

## 8. Rollout order

1. **Self-service auth**: sess-cookie verification + onboarding/invites on
   `baby.32b.io`; migrate the existing household. Product works for
   strangers, free.
2. **Billing**: Stripe integration + entitlement gating. Product is billable.
3. **Trust**: auth hardening (§5), staging env, backups, rate limits.
4. **Premium surfaces**: OAuth AS → MCP, then Alexa certification.
5. **Open up**: landing page, legal docs, open signup.

Each rollout step is independently shippable and testable; steps 1–2 are the
minimum billable product.
