# Architecture

babylog is a single **Cloudflare Worker**, deployed against one **D1** (SQLite)
database, that exposes three interfaces over the same data:

- **MCP** at `/mcp` — the Model Context Protocol server ([tool reference](./mcp-tools.md))
- **Web app** at `/app` — a browser UI ([details](./web-ui.md))
- **Alexa** at `/alexa` — a bilingual (Spanish + English) voice skill ([setup](../alexa-skill/README.md))

All three read and write the same per-household data, so an event logged by
voice shows up in the web app and is queryable over MCP.

## Authentication

Two identity sources feed one `getIdentityEmail()` (`src/identity.ts`), tried
in order — during the llera.eu → 32b.io transition both stay live at once:

1. **Cloudflare Access JWT** — `baby.llera.eu`. Access runs the entire OAuth
   2.1 flow for MCP clients (discovery, dynamic client registration, IdP
   login); browsers get the normal Access login. The Worker verifies the
   `Cf-Access-Jwt-Assertion` header Access stamps (team JWKS + issuer + AUD,
   `src/access.ts`) — `workers_dev: false` keeps the unfronted
   `*.workers.dev` origin closed — and reads the JWT's `email` claim.
2. **babylog's own session cookie** — `baby.32b.io`. `__Host-bsess`, HS256,
   minted by this Worker (`src/session.ts`) after it completes an OpenID
   Connect authorization-code flow against `auth.32b.io` (`src/oidc.ts`). A
   completed login is taken as email-ownership proof.

### The OIDC client (2026-08-01)

babylog is a **confidential client** of `https://auth.32b.io/t/t_32b`: code +
PKCE (S256), exchanged server-side once, after which this Worker mints the
session above and does not talk to the IdP again until it expires. There are no
refresh tokens and no token store — that is the client shape stage 3 of
32b-auth's roadmap scoped to, and it is why nothing here has to be stored.

- `GET /auth/login` — builds the authorization request (state, nonce, PKCE
  verifier) into a short-lived `__Host-blogin` cookie and redirects to the IdP.
- `GET /auth/callback` — checks `state`, exchanges the code with
  `client_secret_basic`, verifies the id_token against the keys published at the
  IdP's `jwks_uri`, checks `nonce`, mints the session.
- `GET|POST /auth/logout` — clears babylog's session. Local only: the IdP
  advertises no `end_session` endpoint, so this says nothing about the estate's
  session.

**Only the issuer is pinned.** Every endpoint and every key is read from the
discovery document beneath it, cached per isolate. A client holding its own copy
of the signing key is precisely what cannot notice a rotation, which is why the
old `SESSION_PUBLIC_JWK` var is gone rather than repurposed.

**Why this replaced the shared cookie rather than joining it.** The estate's
`sess` cookie is scoped `Domain=32b.io`, so any 32b.io host can set one — and a
host-only plant sorts ahead of the real one. `auth.32b.io` cannot move it to a
`__Host-` prefix, which is what closes that hole, until no product reads the
shared cookie. babylog was one of three. So the assertion that a well-formed
`sess` cookie now buys *nothing* here is a test rather than a remark
(`test/session.test.ts`, `test/identity.test.ts`).

Tenant `t_32b` has `subject_type: public`, so the `sub` in an id_token is the
same `u_<ULID>` account id the shared cookie carried. No data moved.

If neither is present, `DEV_USER_EMAIL` (`.dev.vars` only, never a production
var) supplies identity for `wrangler dev` — but only when the request's host
is `localhost`/`127.0.0.1`, so a stray `DEV_USER_EMAIL` can never authenticate
anyone in production.

The Alexa endpoint has no Access *identity* (it is reached through an AWS Lambda,
not a browser). Its events are attributed to a fixed `alexa` identity and go to
the household in `ALEXA_HOUSEHOLD_ID` (default `1`).

It does, however, have Access *authentication*, and as of **2026-07-31** that is
the only thing guarding it. The path is Echo → Amazon → the
`ha-alexa-smart-home` Lambda (eu-west-1) → `https://baby.32b.io/alexa`, and the
Lambda forwards the envelope with `CF-Access-Client-Id` / `CF-Access-Client-Secret`
for the `alexa-lambda` service token. `ALEXA_SKIP_SIGNATURE=true` is **correct
here, not a shortcut**: Amazon signs only HTTPS skill endpoints, and this skill's
endpoint is the Lambda, so no `Signature` headers ever arrive. The same flag also
disables the `applicationId` check.

Which means the service token is the whole gate — and the Access app enforcing it
covered only `baby.llera.eu` until 2026-07-31. Once `baby.32b.io` became the live
hostname, the Lambda's credentials arrived at a host with no app to evaluate them
and `/alexa` accepted anonymous reads and writes into household `1`. The fix was
the missing app: **`baby-alexa`** (id `4818d550-d1e7-46ed-ac5b-573b34c16585`),
path-scoped to `baby.32b.io/alexa`, one `non_identity` policy admitting only that
service token. Verified both ways — the Lambda gets through, an anonymous POST
carrying the correct `applicationId` gets 403, and `/`, `/app` and `/mcp` are
untouched.

Treat `/alexa` as unauthenticated *at the Worker*: everything protecting it lives
in Cloudflare. Reasoning about its security from this repo alone will reach the
wrong conclusion, which is exactly the mistake that let the hole persist.

## Multi-user model

- A **household** is the tenancy unit: its caregivers all see and record the
  same data, and households never see each other's data.
- A **user** (email, as authenticated by whichever identity source above
  answered) belongs to exactly one household.
- Each household has one or more **babies**; one of them is the *default*.
  Tools and API calls apply to the default baby unless a `baby` (name or id)
  says otherwise. The web app shows a baby switcher when a household has more
  than one baby.
- Every recorded event stores **who logged it** (`created_by`: the caregiver
  email, or `alexa` for voice entries).
- There is **no silent provisioning**: an authenticated email that is not yet
  registered is gated to `/welcome` (`src/onboard.ts`), where it takes exactly
  one of two explicit paths. Either an existing caregiver in the *same*
  household invited it — a pending row in the `invites` table (migration
  0004), created by `add_caregiver`/the web app's Settings tab — and it
  accepts or declines on `/welcome`; or it creates its own new, isolated
  household via `/welcome`'s create form (`createHouseholdForEmail`, always
  the caller's own email — distinct from the MCP `create_household` tool,
  which can provision a new tenant for an arbitrary email). Silent auto-join
  on first login is deliberately not offered: it would let one mistyped or
  coincidental email match silently merge two families' data.

## Storage

The Durable Object is required by the MCP transport; persistent data lives in
D1 so it is shared across sessions and clients.

Timestamps are stored as ISO 8601 UTC strings (e.g. `2026-05-14T07:30:00Z`).
"Days" (for daily rollups such as `check_indications` and
`get_stats window='today'`) are **Europe/Madrid** calendar days — the household
timezone — consistent across the MCP tools, the web UI, and the Alexa skill.

## Code layout

```
.
├── src/
│   ├── index.ts                    # Router; resolves identity, threads it, /app + /welcome gating
│   ├── identity.ts                 # getIdentityEmail(): Access JWT → own session → DEV_USER_EMAIL
│   ├── access.ts                   # Access JWT verification
│   ├── oidc.ts                     # OIDC client: /auth/login, /auth/callback, /auth/logout
│   ├── session.ts                  # babylog's own session cookie (__Host-bsess, HS256)
│   ├── onboard.ts                  # /welcome: accept/decline invite, create household
│   ├── users.ts                    # Tenancy: users → households → babies; invites
│   ├── tools.ts                    # McpAgent (Durable Object) + MCP tools
│   ├── api.ts                      # JSON API for the web app (/api/*)
│   ├── web.ts                      # App shell serving + PWA assets
│   ├── app.html                    # Browser app shell (served at /app)
│   ├── icons.ts                    # PNG app icons (base64) for iOS/Android
│   ├── alexa.ts                    # /alexa endpoint for the Alexa skill
│   ├── alexa-i18n.ts               # Alexa localization (es-ES / en voices)
│   ├── lib.ts                      # Pure helpers (timezone, gaps, ages)
│   ├── growth.ts                   # Growth-based targets (weight/age → target); pure, tested
│   ├── types.ts                    # Env + DB row types
│   └── html.d.ts                   # Type shim: import *.html as string
├── test/
│   ├── lib.test.ts                 # Unit tests for the pure helpers
│   ├── users.test.ts               # Unit tests for baby selection (pickBaby)
│   ├── identity.test.ts            # Unit tests for getIdentityEmail()
│   ├── session.test.ts             # Unit tests for the session cookie
│   ├── oidc.test.ts                # The code+PKCE flow against a stubbed IdP
│   ├── growth.test.ts              # Unit tests for growth-based targets
│   ├── app-i18n.test.ts            # Cross-checks app.html's i18n keys against the ES dictionary
│   ├── belly-calib.test.ts         # Unit tests for the belly ring's calibration backtest
│   ├── belly-kernel.test.ts        # Unit tests for the belly ring's hunger-curve kernel
│   ├── belly-ring.dom.test.ts      # DOM tests for the belly ring (jsdom)
│   └── alexa.test.ts               # Unit tests for the Alexa voices
├── alexa-skill/
│   ├── interaction-model.es-ES.json  # Spanish voice model to upload to Alexa
│   ├── interaction-model.en.json     # English voice model (en-US + en-GB)
│   └── README.md                     # Step-by-step skill setup
├── migrations/                     # 0001..NNNN sequential D1 schema migrations
├── wrangler.jsonc                  # Worker + Durable Object + D1 bindings
├── tsconfig.json
└── package.json
```
