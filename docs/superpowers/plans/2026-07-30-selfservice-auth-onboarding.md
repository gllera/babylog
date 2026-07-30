# Self-Service Auth + Onboarding on baby.32b.io — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rollout step 1 of `docs/superpowers/specs/2026-07-30-saas-billing-design.md` — babylog becomes reachable at `baby.32b.io` behind the existing 32b.io magic-link session, with self-service onboarding (create-household / accept-invite) replacing the Cloudflare Access allowlist. `baby.llera.eu` + Access keep working unchanged in parallel (MCP and Alexa stay on that path until rollout step 4).

**Architecture:** The Worker gains a second identity source: alongside the Access JWT it learns to verify the 32b.io `sess` cookie (HMAC-SHA256, minted by www.32b.io's magic-link login — see `~/ws/32b/functions/_lib/auth.js`), sharing `SESSION_SECRET`. Caregiver adds become **pending invites** (new `invites` table) that the invitee explicitly accepts on a new server-rendered `/welcome` page; the same page offers create-a-household. `/app` gates: no identity → 302 to the 32b.io login; identity without a household → 303 `/welcome`.

**Tech Stack:** Cloudflare Workers (TypeScript), D1 (SQLite migrations), vitest (plain Node — no workers runtime in tests), zod, wrangler.

---

## Context primer (read first)

- **Repo:** `~/ws/babylog`. One Worker (`src/index.ts` routes), one D1 DB. Tenancy: `households → users(email) → babies → records`; resolution in `src/users.ts` (`resolveTenant`, deliberately **no** auto-provisioning — see its closing comment).
- **Auth today:** Cloudflare Access fronts `baby.llera.eu`; `src/access.ts` verifies the forwarded JWT. `DEV_USER_EMAIL` in `.dev.vars` supplies identity under `wrangler dev`.
- **The 32b.io session** (reference implementation `~/ws/32b/functions/_lib/auth.js`): cookie `sess=<b64u(payload)>.<b64u(hmac-sha256 sig)>`, payload `{t:'sess', e:<email>, x?:<expiry ms>}` (today's tokens omit `x`), key = `SESSION_SECRET`, cookie `Domain=32b.io` so every subdomain receives it. Login page: `https://www.32b.io/login?next=<url>` (`next` restricted to `*.32b.io`).
- **Tests:** `npm test` (vitest, plain Node — D1-bound functions have no test harness in this repo and are exercised by the Task 6 smoke script; pure functions get unit tests). `npm run typecheck` must stay clean.
- **Commits:** small, present-tense, `type(scope): summary` (see `git log`). Never push until the final task says so — a push to `main` deploys to production.

## File structure

| File | Role in this plan |
| --- | --- |
| `src/session.ts` (new) | 32b sess-token codec: mint/verify/extract. Pure, unit-tested. |
| `src/identity.ts` (new) | One `getIdentityEmail()`: Access JWT → sess cookie → `DEV_USER_EMAIL`. |
| `src/access.ts` (modify) | Slims to JWT verification only (`getAccessEmail` moves into identity.ts). |
| `src/onboard.ts` (new) | `/welcome` page: render + create/accept/decline handlers + login redirect. |
| `src/users.ts` (modify) | Invite helpers + `createHouseholdForEmail`; `addCaregiver` → `inviteCaregiver`. |
| `src/api.ts` (modify) | Identity swap; caregiver POST invites; `/api/invites/<id>` DELETE; household payload gains `pending`. |
| `src/index.ts` (modify) | Identity swap on `/mcp`; `/app` + `/welcome` gating. |
| `src/tools.ts` (modify) | `add_caregiver` invites; stale Access wording in tool texts. |
| `src/types.ts` (modify) | `Env.SESSION_SECRET?: string`. |
| `src/app.html` (modify) | Caregivers ledger shows pending invites with revoke ×. |
| `migrations/0004_invites.sql` (new) | `invites` table. |
| `test/session.test.ts` (new) | Codec unit tests. |
| `wrangler.jsonc`, `.dev.vars`, `docs/setup.md`, `docs/architecture.md`, `README.md` | Route, secret, docs. |

---

### Task 1: Session token codec (`src/session.ts`)

**Files:**
- Create: `src/session.ts`
- Test: `test/session.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/session.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  makeToken,
  readToken,
  getSessionToken,
  getSessionEmail,
} from "../src/session";

const SECRET = "test-secret";

describe("session token codec", () => {
  it("round-trips a valid sess token", async () => {
    const tok = await makeToken(SECRET, { t: "sess", e: "Ana@Example.com" });
    const payload = await readToken(SECRET, tok, "sess");
    expect(payload).toEqual({ t: "sess", e: "Ana@Example.com" });
  });

  it("rejects a tampered signature", async () => {
    const tok = await makeToken(SECRET, { t: "sess", e: "a@b.c" });
    const [body] = tok.split(".");
    const other = await makeToken("other-secret", { t: "sess", e: "a@b.c" });
    const forged = `${body}.${other.split(".")[1]}`;
    expect(await readToken(SECRET, forged, "sess")).toBeNull();
  });

  it("rejects the wrong token type", async () => {
    const tok = await makeToken(SECRET, { t: "login", e: "a@b.c" });
    expect(await readToken(SECRET, tok, "sess")).toBeNull();
  });

  it("rejects an expired token and accepts a future expiry", async () => {
    const dead = await makeToken(SECRET, { t: "sess", e: "a@b.c", x: Date.now() - 1000 });
    expect(await readToken(SECRET, dead, "sess")).toBeNull();
    const live = await makeToken(SECRET, { t: "sess", e: "a@b.c", x: Date.now() + 60_000 });
    expect(await readToken(SECRET, live, "sess")).toEqual({ t: "sess", e: "a@b.c", x: expect.any(Number) });
  });

  it("returns null on malformed tokens", async () => {
    expect(await readToken(SECRET, "", "sess")).toBeNull();
    expect(await readToken(SECRET, "no-dot", "sess")).toBeNull();
    expect(await readToken(SECRET, "!!.!!", "sess")).toBeNull();
  });

  it("extracts the sess cookie among other cookies", () => {
    expect(getSessionToken("a=1; sess=tok.sig; b=2")).toBe("tok.sig");
    expect(getSessionToken("sess=solo")).toBe("solo");
    expect(getSessionToken("nosess=1")).toBeNull();
    expect(getSessionToken(null)).toBeNull();
  });

  it("getSessionEmail reads the request cookie and lowercases", async () => {
    const tok = await makeToken(SECRET, { t: "sess", e: "Ana@Example.com" });
    const req = new Request("https://baby.32b.io/app", {
      headers: { Cookie: `sess=${tok}` },
    });
    expect(await getSessionEmail(req, SECRET)).toBe("ana@example.com");
    expect(await getSessionEmail(new Request("https://baby.32b.io/app"), SECRET)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/session.test.ts`
Expected: FAIL — `Cannot find module '../src/session'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

Create `src/session.ts` — a TypeScript port of `~/ws/32b/functions/_lib/auth.js` (verification side; `makeToken` is kept for tests and future use):

```ts
// -----------------------------------------------------------------------------
// 32b.io session verification. www.32b.io's magic-link login (see ~/ws/32b)
// mints HMAC-SHA256 tokens `b64u(JSON payload) + "." + b64u(signature)` and
// sets them as a `sess` cookie with Domain=32b.io — so baby.32b.io receives
// them on every request. Payload: { t: 'sess', e: <email>, x?: <expiry ms> }.
// Today's tokens omit `x` (they never expire); `x` is honored when present so
// the planned session-expiry hardening needs no verifier change here.
// -----------------------------------------------------------------------------

const enc = new TextEncoder();

const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const unb64u = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0)
  );

// usages is string[] because @cloudflare/workers-types types importKey that
// way (KeyUsage is a DOM lib type and "dom" isn't in this repo's tsconfig).
const hmacKey = (secret: string, usages: string[]) =>
  crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );

// `e` is optional: readToken returns any validly-signed payload of the right
// type — only getSessionEmail guarantees a usable email. NOTE: a token STRING
// is not canonical (extra dot segments / base64 padding verify identically);
// never key anything (e.g. future revocation) on token-string equality.
export type SessPayload = { t: string; e?: string; x?: number };

export async function makeToken(
  secret: string,
  payload: SessPayload
): Promise<string> {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret, ["sign"]);
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(body))
  );
  return `${body}.${b64u(sig)}`;
}

// The payload if the signature verifies, `t` matches and `x` (when present)
// is still in the future; else null.
export async function readToken(
  secret: string,
  token: string,
  type: string
): Promise<SessPayload | null> {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  try {
    const key = await hmacKey(secret, ["verify"]);
    if (!(await crypto.subtle.verify("HMAC", key, unb64u(sig), enc.encode(body)))) {
      return null;
    }
    const payload = JSON.parse(
      new TextDecoder().decode(unb64u(body))
    ) as SessPayload;
    if (payload.t !== type) return null;
    if (payload.x !== undefined && (typeof payload.x !== "number" || payload.x < Date.now())) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function getSessionToken(cookieHeader: string | null): string | null {
  const m = (cookieHeader || "").match(/(?:^|;\s*)sess=([^;]+)/);
  return m ? m[1] : null;
}

// The lowercased email behind the request's sess cookie, or null.
export async function getSessionEmail(
  request: Request,
  secret: string
): Promise<string | null> {
  const token = getSessionToken(request.headers.get("Cookie"));
  if (!token) return null;
  const payload = await readToken(secret, token, "sess");
  return typeof payload?.e === "string" && payload.e
    ? payload.e.toLowerCase()
    : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/session.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/session.ts test/session.test.ts
git commit -m "feat(auth): port the 32b.io sess-token codec"
```

---

### Task 2: Unified identity (`src/identity.ts`)

**Files:**
- Create: `src/identity.ts`
- Modify: `src/access.ts:55-72` (delete `getAccessEmail`), `src/api.ts:36,678`, `src/index.ts:6,37`, `src/types.ts:1-15`

- [ ] **Step 1: Add `SESSION_SECRET` to Env**

In `src/types.ts`, inside `Env` after `POLICY_AUD: string;` add:

```ts
  // HMAC key for the 32b.io `sess` cookie (same value as the www.32b.io
  // Pages secret). Optional: absent, the sess-cookie auth path is disabled.
  SESSION_SECRET?: string;
```

- [ ] **Step 2: Create `src/identity.ts`**

```ts
// -----------------------------------------------------------------------------
// Request identity. Two production auth paths during the llera.eu → 32b.io
// transition:
//   1. Cloudflare Access JWT — baby.llera.eu, stamped by the Access app
//      (still fronts MCP and the legacy origin until the OAuth AS lands).
//   2. The 32b.io `sess` cookie — baby.32b.io, minted by the www.32b.io
//      magic-link login (a completed login is email-ownership proof).
// Dev fallback: DEV_USER_EMAIL (.dev.vars only — never a production var) so
// `wrangler dev` works with neither in front.
// -----------------------------------------------------------------------------

import { verifyAccessJwt } from "./access";
import { getSessionEmail } from "./session";
import type { Env } from "./types";

export async function getIdentityEmail(
  request: Request,
  env: Env
): Promise<string | null> {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (jwt) {
    const payload = await verifyAccessJwt(jwt, env);
    if (typeof payload?.email === "string" && payload.email) {
      return payload.email.toLowerCase();
    }
  }
  if (env.SESSION_SECRET) {
    const email = await getSessionEmail(request, env.SESSION_SECRET);
    if (email) return email;
  }
  if (env.DEV_USER_EMAIL) return env.DEV_USER_EMAIL.toLowerCase();
  return null;
}
```

- [ ] **Step 3: Slim `src/access.ts` to JWT verification**

Delete the whole `getAccessEmail` function **and** its preceding comment block (`src/access.ts:55-72`, from `// The identity (lowercased email) behind a request…` to the end of the file). `verifyAccessJwt` and everything above stays.

- [ ] **Step 4: Swap the two call sites**

In `src/index.ts`: replace `import { getAccessEmail } from "./access";` with `import { getIdentityEmail } from "./identity";`, and at the `/mcp` block replace `const email = await getAccessEmail(request, env);` with `const email = await getIdentityEmail(request, env);`.

In `src/api.ts`: replace `import { getAccessEmail } from "./access";` with `import { getIdentityEmail } from "./identity";`, and in `handleApi` replace `const email = await getAccessEmail(request, env);` with `const email = await getIdentityEmail(request, env);`. Update the comment above it to:

```ts
  // Identity is load-bearing with tenants: an Access JWT (baby.llera.eu) or
  // a 32b.io sess cookie (baby.32b.io) must name the caller.
```

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck`
Expected: all green (no existing test imports `getAccessEmail`).

- [ ] **Step 6: Commit**

```bash
git add src/identity.ts src/access.ts src/api.ts src/index.ts src/types.ts
git commit -m "feat(auth): accept 32b.io session cookies alongside Access JWTs"
```

---

### Task 3: Invites schema + tenancy helpers

**Files:**
- Create: `migrations/0004_invites.sql`
- Modify: `src/users.ts` (add helpers at the end of the file)

D1-bound functions have no unit harness in this repo (tests are plain-Node by design — see the header of `src/users.ts`); these helpers are exercised end-to-end by the Task 6 smoke script.

- [ ] **Step 1: Write the migration**

Create `migrations/0004_invites.sql`:

```sql
-- Caregiver invites: a pending, explicitly-accepted membership offer.
-- add_caregiver no longer inserts into users directly — that silently claimed
-- the email (a typo would block its real owner from ever creating their own
-- household). It creates an invite instead; the invitee sees it on /welcome
-- after magic-link login (which proves email ownership) and accepting it
-- inserts the users row.
CREATE TABLE invites (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id  INTEGER NOT NULL,
  email         TEXT    NOT NULL,               -- stored lowercased
  invited_by    TEXT,                           -- inviter's email, shown on /welcome
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (household_id, email)
);

CREATE INDEX idx_invites_email ON invites(email);
```

- [ ] **Step 2: Apply locally**

Run: `npm run db:migrate:local`
Expected: `0004_invites.sql` listed as applied.

- [ ] **Step 3: Add the helpers to `src/users.ts`**

Append at the end of the file:

```ts
// ---- Invites & self-serve onboarding ----------------------------------------

export type InviteRow = {
  id: number;
  household_id: number;
  email: string;
  invited_by: string | null;
  household_name: string | null;
};

// Pending invites for an email, joined with the household name for /welcome.
export async function listInvitesForEmail(
  db: D1Database,
  email: string
): Promise<InviteRow[]> {
  const { results } = await db
    .prepare(
      "SELECT i.id, i.household_id, i.email, i.invited_by, h.name AS household_name FROM invites i LEFT JOIN households h ON h.id = i.household_id WHERE i.email = ? ORDER BY i.id"
    )
    .bind(email.toLowerCase())
    .all<InviteRow>();
  return results;
}

export type PendingInvite = { id: number; email: string };

// A household's outstanding invites, for the caregivers settings panel.
export async function listInvitesForHousehold(
  db: D1Database,
  householdId: number
): Promise<PendingInvite[]> {
  const { results } = await db
    .prepare("SELECT id, email FROM invites WHERE household_id = ? ORDER BY id")
    .bind(householdId)
    .all<PendingInvite>();
  return results;
}

// Create a pending invite. Returns a caller-facing error string, or null on
// success (same contract the old direct-add had). Duplicate invites are a
// silent no-op (OR IGNORE on the UNIQUE(household_id, email) key).
export async function inviteCaregiver(
  db: D1Database,
  householdId: number,
  email: string,
  invitedBy: string
): Promise<string | null> {
  const norm = email.trim().toLowerCase();
  const existing = await db
    .prepare("SELECT id, email, household_id FROM users WHERE email = ?")
    .bind(norm)
    .first<UserRow>();
  if (existing) {
    return existing.household_id === householdId
      ? `${norm} is already a caregiver in your household.`
      : `${norm} already belongs to another household.`;
  }
  await db
    .prepare(
      "INSERT OR IGNORE INTO invites (household_id, email, invited_by) VALUES (?, ?, ?)"
    )
    .bind(householdId, norm, invitedBy)
    .run();
  return null;
}

// Owner-side revoke. Rows outside the household simply don't match — same
// "not found" as a bad id, no cross-tenant existence oracle.
export async function revokeInvite(
  db: D1Database,
  householdId: number,
  inviteId: number
): Promise<boolean> {
  const res = await db
    .prepare("DELETE FROM invites WHERE id = ? AND household_id = ?")
    .bind(inviteId, householdId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// Invitee-side accept: the invite must belong to this email. Joining deletes
// ALL invites for the email in the same transaction — an email belongs to
// exactly one household, so the rest just became unusable.
export async function acceptInvite(
  db: D1Database,
  email: string,
  inviteId: number
): Promise<{ ok: true; householdId: number } | { ok: false; message: string }> {
  const norm = email.toLowerCase();
  const invite = await db
    .prepare("SELECT household_id FROM invites WHERE id = ? AND email = ?")
    .bind(inviteId, norm)
    .first<{ household_id: number }>();
  if (!invite) return { ok: false, message: "That invite no longer exists." };
  const already = await db
    .prepare("SELECT id FROM users WHERE email = ?")
    .bind(norm)
    .first<{ id: number }>();
  if (already) return { ok: false, message: "You already belong to a household." };
  await db.batch([
    db
      .prepare("INSERT INTO users (email, household_id) VALUES (?, ?)")
      .bind(norm, invite.household_id),
    db.prepare("DELETE FROM invites WHERE email = ?").bind(norm),
  ]);
  return { ok: true, householdId: invite.household_id };
}

export async function declineInvite(
  db: D1Database,
  email: string,
  inviteId: number
): Promise<boolean> {
  const res = await db
    .prepare("DELETE FROM invites WHERE id = ? AND email = ?")
    .bind(inviteId, email.toLowerCase())
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// Self-serve household creation from /welcome. Mirrors the MCP
// create_household batch (households → users → babies in one transaction —
// D1 rolls the whole batch back on any failure). Guard: the email must not
// be registered yet. Any pending invites die with the choice.
export async function createHouseholdForEmail(
  db: D1Database,
  email: string,
  name?: string
): Promise<{ ok: true; householdId: number } | { ok: false; message: string }> {
  const norm = email.toLowerCase();
  const existing = await db
    .prepare("SELECT id FROM users WHERE email = ?")
    .bind(norm)
    .first<{ id: number }>();
  if (existing) return { ok: false, message: "You already belong to a household." };
  await db.batch([
    db.prepare("INSERT INTO households (name) VALUES (?)").bind(name ?? null),
    db
      .prepare(
        "INSERT INTO users (email, household_id) VALUES (?, last_insert_rowid())"
      )
      .bind(norm),
    db
      .prepare(
        "INSERT INTO babies (household_id, is_default) SELECT household_id, 1 FROM users WHERE email = ?"
      )
      .bind(norm),
    db.prepare("DELETE FROM invites WHERE email = ?").bind(norm),
  ]);
  const user = await db
    .prepare("SELECT household_id FROM users WHERE email = ?")
    .bind(norm)
    .first<{ household_id: number }>();
  return { ok: true, householdId: user?.household_id ?? 0 };
}
```

- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add migrations/0004_invites.sql src/users.ts
git commit -m "feat(auth): invites schema + self-serve household helpers"
```

> **Post-review amendments** (applied in a follow-up commit; `src/users.ts` is
> authoritative): `inviteCaregiver` no longer reports "already belongs to
> another household" — a registered-elsewhere email silently gets a pending
> invite (no cross-tenant existence oracle; it only becomes acceptable if
> they leave that household). `acceptInvite` re-verifies the invite inside
> the batch (revoke-wins race) with a self-guarding cleanup, and both it and
> `createHouseholdForEmail` map the users.email UNIQUE race to the friendly
> "already belong" error; `createHouseholdForEmail` resolves the new id via
> a 5th in-batch SELECT (no `?? 0` fallback). Task 6's smoke should also
> cover double-accept and accept-after-revoke.

---

### Task 4: Caregiver adds become pending invites

**Files:**
- Modify: `src/users.ts` (delete `addCaregiver`), `src/api.ts` (`handleCaregivers` POST, `handleHousehold`, new `/api/invites` branch), `src/tools.ts:2007-2034` (`add_caregiver` tool) and `src/tools.ts:2083-2104` (`create_household` description), `src/app.html:2603,2755-2771,5263-5267` + ES dictionary (~line 1875)

- [ ] **Step 1: Delete the old direct-add**

In `src/users.ts`, delete the `addCaregiver` function and its comment block (the one starting `// Register \`email\` into the household…`, lines 75-99). `inviteCaregiver` (Task 3) is its replacement.

- [ ] **Step 2: Rewire the API**

In `src/api.ts`:

a. In the imports from `"./users"`, remove `addCaregiver` and add `inviteCaregiver`, `listInvitesForHousehold`, `revokeInvite`.

b. In `handleCaregivers`, replace the POST branch body:

```ts
  if (method === "POST" && !idStr) {
    const parsed = await readBody(
      request,
      z.object({ email: z.string().email() })
    );
    if (!parsed.ok) return jsonError(400, parsed.error);
    const error = await inviteCaregiver(
      env.DB,
      tenant.householdId,
      parsed.value.email,
      tenant.email
    );
    if (error) return jsonError(409, error);
    return jsonOk({ invited: parsed.value.email.trim().toLowerCase() }, 201);
  }
```

c. In `handleHousehold`, add a `pending` field:

```ts
async function handleHousehold(env: Env, tenant: Tenant): Promise<Response> {
  return jsonOk({
    household_id: tenant.householdId,
    me: { id: tenant.userId, email: tenant.email },
    caregivers: await listCaregivers(env.DB, tenant.householdId),
    pending: await listInvitesForHousehold(env.DB, tenant.householdId),
    babies: tenant.babies,
  });
}
```

d. In `handleApi`, directly after the `caregivers` branch (`src/api.ts:711-713`), add:

```ts
  if (parts[1] === "invites" && parts.length === 3) {
    if (request.method.toUpperCase() !== "DELETE") {
      return jsonError(405, "Method not allowed.");
    }
    const id = parseIdParam(parts[2]);
    if (id === null) return jsonError(400, "Invalid id.");
    if (!(await revokeInvite(env.DB, tenant.householdId, id))) {
      return jsonError(404, `No pending invite #${id} in your household.`);
    }
    return jsonOk({ deleted: id });
  }
```

- [ ] **Step 3: Rewire the MCP tools**

In `src/tools.ts`, `add_caregiver` registration (line ~2007): update imports at the top of the file (`addCaregiver` → `inviteCaregiver` in the `"./users"` import list), then replace the description and handler:

```ts
      "add_caregiver",
      {
        description:
          "Invite another caregiver's email into the caller's household so they see and record the same data. The invite is pending until that person logs in at www.32b.io and accepts it on the welcome screen (their login proves they own the email).",
        inputSchema: {
          email: z
            .string()
            .email()
            .describe("Email address of the caregiver to invite"),
        },
      },
      async ({ email }) => {
        const t = await this.tenant();
        const norm = email.toLowerCase();
        const error = await inviteCaregiver(db, t.householdId, email, t.email);
        if (error) {
          return { content: [{ type: "text", text: error }], isError: true };
        }
        return {
          content: [
            {
              type: "text",
              text: `Invited ${norm} — they'll join your household when they log in and accept.`,
            },
          ],
        };
      }
```

Also in `src/tools.ts`, edit two stale Access mentions (text only, no logic):
- `create_household` description (line ~2087): delete the trailing sentence `The caregiver must also be allowed by the Cloudflare Access policy (managed in Cloudflare, not here).`
- `remove_caregiver` description (line ~2040): delete the trailing sentence `This does not touch the Cloudflare Access policy (that lives in Cloudflare, not here).`

- [ ] **Step 4: Show pending invites in the app shell**

In `src/app.html`:

a. Caller (line ~2603): `renderSettingsCaregivers(d.caregivers || [], d.me || {});` becomes

```js
        renderSettingsCaregivers(d.caregivers || [], d.me || {}, d.pending || []);
```

b. `renderSettingsCaregivers` (line ~2755): add the `pending` parameter and append invite rows after the caregiver loop (before the two `innerHTML` assignments):

```js
    function renderSettingsCaregivers(caregivers, me, pending) {
      var roster = "", ledger = "";
      for (var i = 0; i < caregivers.length; i++) {
        var c = caregivers[i];
        var self = c.id === me.id;
        var email = escapeHtml(c.email);
        var tag = self ? '<span class="ledger-tag">' + escapeHtml(i18n("you")) + '</span>' : "";
        roster += '<span class="roster-row"><span class="roster-main">' + email + '</span>' + tag + '</span>';
        ledger += '<div class="ledger-row"><div class="ledger-line">' +
          '<span class="grow">' + email + '</span>' + tag + '</div>' +
          (self ? "" : '<button type="button" class="delete-btn cg-remove" data-id="' + c.id +
            '" aria-label="' + escapeHtml(i18n("Remove")) + '" title="' + escapeHtml(i18n("Remove")) + '">&times;</button>') +
          '</div>';
      }
      for (var j = 0; j < pending.length; j++) {
        var p = pending[j];
        var pEmail = escapeHtml(p.email);
        var pTag = '<span class="ledger-tag">' + escapeHtml(i18n("invited")) + '</span>';
        roster += '<span class="roster-row"><span class="roster-main">' + pEmail + '</span>' + pTag + '</span>';
        ledger += '<div class="ledger-row"><div class="ledger-line">' +
          '<span class="grow">' + pEmail + '</span>' + pTag + '</div>' +
          '<button type="button" class="delete-btn inv-remove" data-id="' + p.id +
          '" aria-label="' + escapeHtml(i18n("Remove")) + '" title="' + escapeHtml(i18n("Remove")) + '">&times;</button>' +
          '</div>';
      }
      document.getElementById("settings-caregivers").innerHTML = roster;
      document.getElementById("ledger-caregivers").innerHTML = ledger;
    }
```

c. Shared two-tap delete listener (line ~5263): between the `cg-remove` branch and its `} else {`, insert:

```js
        } else if (t.classList.contains("inv-remove")) {
          await sendJson("DELETE", "/api/invites/" + encodeURIComponent(id));
          toast(i18n("Removed"));
          loadSettings();
```

d. ES dictionary (line ~1875, next to `"you": "tú",`): add

```js
        "invited": "invitado",
```

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck`
Expected: all green — `test/app-i18n.test.ts` in particular must pass (it cross-checks i18n keys used in markup against the ES dictionary; if it fails on `invited`, the dictionary entry from step 4d is missing or misspelled).

- [ ] **Step 6: Commit**

```bash
git add src/users.ts src/api.ts src/tools.ts src/app.html
git commit -m "feat(web): caregiver adds become pending invites"
```

---

### Task 5: `/welcome` onboarding page + `/app` gate

**Files:**
- Create: `src/onboard.ts`
- Modify: `src/index.ts` (routes for `/app` and `/welcome`)

- [ ] **Step 1: Create `src/onboard.ts`**

```ts
// -----------------------------------------------------------------------------
// Self-service onboarding: /welcome. A logged-in email with no users row lands
// here (index.ts gates /app) and takes exactly one of two explicit paths —
// accept a pending invite, or create a new household. There is deliberately
// no third path: silent provisioning would split one family into two tenants
// (see resolveTenant's comment in users.ts).
// -----------------------------------------------------------------------------

import type { Env } from "./types";
import {
  acceptInvite,
  createHouseholdForEmail,
  declineInvite,
  listInvitesForEmail,
  resolveTenant,
  type InviteRow,
} from "./users";

export const LOGIN_URL = "https://www.32b.io/login";

// 302 to the 32b.io magic-link login, returning here afterwards (`next` is
// validated to *.32b.io by www's safeNext, so this survives open-redirect
// scrutiny on both ends).
export function loginRedirect(url: URL): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${LOGIN_URL}?next=${encodeURIComponent(url.toString())}`,
    },
  });
}

// Browsers send an Origin header on every POST; a same-origin form post's
// Origin equals the request origin. Anything else is a cross-site post —
// rejected, so a hostile page can't create households or accept invites with
// the visitor's cookie.
function crossOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  return origin !== null && origin !== url.origin;
}

type Lang = "en" | "es";

const STR: Record<Lang, Record<string, string>> = {
  en: {
    title: "Welcome",
    signedInAs: "Signed in as",
    invitesIntro: "You have been invited to join:",
    invitedBy: "invited by",
    household: "household",
    accept: "Join",
    decline: "Decline",
    orCreate: "Or start your own:",
    createIntro: "Create a household for your family. Caregivers you invite later will share the same diary.",
    nameLabel: "Household name (optional)",
    create: "Create household",
  },
  es: {
    title: "Bienvenido",
    signedInAs: "Sesión iniciada como",
    invitesIntro: "Te han invitado a unirte a:",
    invitedBy: "invitación de",
    household: "hogar",
    accept: "Unirme",
    decline: "Rechazar",
    orCreate: "O crea el tuyo:",
    createIntro: "Crea un hogar para tu familia. Los cuidadores que invites después compartirán el mismo diario.",
    nameLabel: "Nombre del hogar (opcional)",
    create: "Crear hogar",
  },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Squared, hairline, elder-friendly — the app's design language, server-side.
function renderWelcome(
  email: string,
  invites: InviteRow[],
  lang: Lang,
  error?: string
): string {
  const s = STR[lang];
  const inviteBlocks = invites
    .map((inv) => {
      const label = escapeHtml(inv.household_name || `${s.household} #${inv.household_id}`);
      const by = inv.invited_by
        ? `<div class="sub">${s.invitedBy} ${escapeHtml(inv.invited_by)}</div>`
        : "";
      return `<form method="post" class="invite">
        <input type="hidden" name="invite_id" value="${inv.id}">
        <div class="grow"><div>${label}</div>${by}</div>
        <button type="submit" name="action" value="accept" class="primary">${s.accept}</button>
        <button type="submit" name="action" value="decline">${s.decline}</button>
      </form>`;
    })
    .join("");
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${s.title} — babylog</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: system-ui, sans-serif; font-size: 18px; color: #111;
         background: #fafafa; display: flex; justify-content: center; padding: 24px 16px; }
  main { width: 100%; max-width: 28rem; }
  h1 { font-size: 28px; margin: 16px 0 4px; }
  .who { color: #666; margin-bottom: 24px; overflow-wrap: anywhere; }
  section { border: 1px solid #ddd; background: #fff; padding: 20px; margin-bottom: 20px; }
  .lead { margin-bottom: 16px; }
  .sub { color: #666; font-size: 15px; }
  .invite { display: flex; align-items: center; gap: 10px; padding: 12px 0;
            border-top: 1px solid #eee; }
  .invite:first-of-type { border-top: 0; padding-top: 0; }
  .grow { flex: 1 1 auto; min-width: 0; }
  label { display: block; margin-bottom: 6px; }
  input[type=text] { width: 100%; font-size: 18px; padding: 12px; border: 1px solid #ccc;
                     background: #fff; margin-bottom: 16px; }
  button { font-size: 18px; min-height: 56px; padding: 0 20px; border: 1px solid #0070f3;
           background: #fff; color: #0070f3; cursor: pointer; }
  button.primary { background: #0070f3; color: #fff; width: 100%; }
  .invite button { min-height: 48px; width: auto; }
  .error { border: 1px solid #d33; color: #d33; background: #fff;
           padding: 12px 16px; margin-bottom: 20px; }
</style>
</head>
<body>
<main>
  <h1>${s.title}</h1>
  <div class="who">${s.signedInAs} ${escapeHtml(email)}</div>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
  ${invites.length ? `<section><div class="lead">${s.invitesIntro}</div>${inviteBlocks}</section>
  <div class="lead sub">${s.orCreate}</div>` : ""}
  <section>
    <div class="lead">${s.createIntro}</div>
    <form method="post">
      <input type="hidden" name="action" value="create">
      <label for="name">${s.nameLabel}</label>
      <input type="text" id="name" name="name" maxlength="100" autocomplete="off">
      <button type="submit" class="primary">${s.create}</button>
    </form>
  </section>
</main>
</body>
</html>`;
}

function page(html: string): Response {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}

function see(url: URL, path: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: new URL(path, url).toString() },
  });
}

// GET renders; POST handles create/accept/decline. A caller that already has
// a household is always bounced to /app (nothing here applies to them).
export async function handleWelcome(
  request: Request,
  env: Env,
  url: URL,
  email: string
): Promise<Response> {
  const lang: Lang = (request.headers.get("Accept-Language") || "")
    .toLowerCase()
    .startsWith("es")
    ? "es"
    : "en";
  const tenant = await resolveTenant(env.DB, email);
  if (tenant) return see(url, "/app");
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return page(renderWelcome(email, await listInvitesForEmail(env.DB, email), lang));
  }
  if (method === "POST") {
    if (crossOrigin(request, url)) return new Response("Forbidden", { status: 403 });
    const form = await request.formData();
    const action = String(form.get("action") || "");
    if (action === "create") {
      const name = String(form.get("name") || "").trim();
      const res = await createHouseholdForEmail(env.DB, email, name || undefined);
      if (!res.ok) {
        return page(
          renderWelcome(email, await listInvitesForEmail(env.DB, email), lang, res.message)
        );
      }
      return see(url, "/app");
    }
    if (action === "accept" || action === "decline") {
      const id = parseInt(String(form.get("invite_id") || ""), 10);
      if (!Number.isFinite(id) || id <= 0) return see(url, "/welcome");
      if (action === "accept") {
        const res = await acceptInvite(env.DB, email, id);
        if (!res.ok) {
          return page(
            renderWelcome(email, await listInvitesForEmail(env.DB, email), lang, res.message)
          );
        }
        return see(url, "/app");
      }
      await declineInvite(env.DB, email, id);
      return see(url, "/welcome");
    }
    return new Response("Bad request", { status: 400 });
  }
  return new Response("Method not allowed", { status: 405 });
}
```

- [ ] **Step 2: Wire the routes and the `/app` gate in `src/index.ts`**

Add to the imports:

```ts
import { resolveTenant } from "./users";
import { handleWelcome, loginRedirect } from "./onboard";
```

Replace the `/app` block (`src/index.ts:79-81`) with:

```ts
    // /app and /welcome are the two browser entry points. No identity → the
    // 32b.io magic-link login (on baby.llera.eu, Access intercepts first, so
    // this redirect only ever fires on baby.32b.io or in dev). Identity
    // without a household → /welcome (accept an invite or create one).
    if (url.pathname === "/app" || url.pathname === "/app/" || url.pathname === "/welcome") {
      const email = await getIdentityEmail(request, env);
      if (!email) return loginRedirect(url);
      if (url.pathname === "/welcome") {
        return handleWelcome(request, env, url, email);
      }
      const tenant = await resolveTenant(env.DB, email);
      if (!tenant) {
        return new Response(null, { status: 303, headers: { Location: "/welcome" } });
      }
      return handleAppHome(request);
    }
```

- [ ] **Step 3: Verify**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/onboard.ts src/index.ts
git commit -m "feat(web): /welcome onboarding + /app session gate"
```

> **Post-review amendments** (in the landed commit; code is authoritative):
> Task 4 also refreshed the stale user-facing Access-allowlist copy
> (settings note, create_household success text, handleCaregivers comment,
> notRegisteredMessage now describes invite→login→accept), ES tag
> "invitado"→"pendiente", and added a data-i18n → ES-dictionary cross-check
> test. Task 5 hardening: `page()` sends `frame-ancestors 'none'` + XFO
> DENY; household name capped server-side (100); `crossOrigin` also checks
> `Sec-Fetch-Site`; garbage POST bodies → 400; `/welcome/` routed;
> `LOGIN_URL` un-exported; the `gotoLogin()` comment in app.html describes
> both login paths.

---

### Task 6: Config, secret, docs, local smoke, deploy

**Files:**
- Modify: `wrangler.jsonc`, `.dev.vars`, `docs/setup.md`, `docs/architecture.md`, `README.md`

- [ ] **Step 1: Declare the route**

In `wrangler.jsonc`, after the `"workers_dev": false,` block add:

```jsonc
  // baby.32b.io — the self-service origin, gated by the 32b.io sess cookie
  // (verified in-Worker; www.32b.io mints it). baby.llera.eu stays attached
  // as a dashboard-managed custom domain behind Cloudflare Access.
  "routes": [{ "pattern": "baby.32b.io", "custom_domain": true }],
```

- [ ] **Step 2: Local dev vars**

Append to `.dev.vars` (gitignored — verify with `git check-ignore .dev.vars`):

```
SESSION_SECRET=dev-secret
```

- [ ] **Step 3: Local smoke test**

```bash
npm run db:migrate:local
# For the redirect check below, temporarily comment out DEV_USER_EMAIL in
# .dev.vars (it would otherwise supply an identity). Restore it afterwards.
npm run dev
```

In a second terminal:

```bash
# 1. No cookie → login redirect
curl -si http://localhost:8787/app | head -3
# Expect: HTTP/1.1 302, Location: https://www.32b.io/login?next=http%3A%2F%2Flocalhost%3A8787%2Fapp

# 2. Forge a sess cookie for a NEW email (same algorithm, dev secret)
mint() { node -e '
const enc=new TextEncoder();
const b64u=b=>btoa(String.fromCharCode(...b)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
(async()=>{
  const body=b64u(enc.encode(JSON.stringify({t:"sess",e:process.argv[1]})));
  const key=await crypto.subtle.importKey("raw",enc.encode("dev-secret"),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const sig=new Uint8Array(await crypto.subtle.sign("HMAC",key,enc.encode(body)));
  console.log(`${body}.${b64u(sig)}`);
})()' "$1"; }
TOK=$(mint newmom@example.com)

# 3. Unregistered email → /welcome, which renders the create form
curl -si -H "Cookie: sess=$TOK" http://localhost:8787/app | head -3          # 303 → /welcome
curl -s  -H "Cookie: sess=$TOK" http://localhost:8787/welcome | grep -c "action"  # ≥1

# 4. Create a household → lands in the app with a default baby
curl -si -H "Cookie: sess=$TOK" --data "action=create&name=Testers" http://localhost:8787/welcome | head -3   # 303 → /app
curl -s  -H "Cookie: sess=$TOK" http://localhost:8787/api/household           # json: household_id ≥ 2, me = newmom

# 5. Invite a second email, accept from its session
curl -s -H "Cookie: sess=$TOK" -H "Content-Type: application/json" \
  --data '{"email":"granddad@example.com"}' http://localhost:8787/api/caregivers   # {"invited":"granddad@example.com"}
TOK2=$(mint granddad@example.com)
curl -s  -H "Cookie: sess=$TOK2" http://localhost:8787/welcome | grep -c "invite_id"   # ≥1
INVITE_ID=1  # or read it from: npx wrangler d1 execute baby-feedings --local --command "SELECT id FROM invites"
curl -si -H "Cookie: sess=$TOK2" --data "action=accept&invite_id=$INVITE_ID" http://localhost:8787/welcome | head -3   # 303 → /app
curl -s  -H "Cookie: sess=$TOK2" http://localhost:8787/api/household           # same household_id as newmom's

# 6. Restore DEV_USER_EMAIL in .dev.vars; confirm the seeded household still resolves
curl -s http://localhost:8787/api/profile | head -c 200                        # babies json, no 401
```

All six must behave as annotated before continuing.

- [ ] **Step 4: Update the docs**

a. `README.md`: replace the paragraph starting `Authentication is **Cloudflare Access**…` with:

```markdown
Authentication is dual during the llera.eu → 32b.io transition: `baby.32b.io`
uses the shared 32b.io magic-link session (self-service — new users create a
household or accept a caregiver invite at `/welcome`), while `baby.llera.eu`
stays behind Cloudflare Access (still fronting MCP and Alexa). The Worker
verifies whichever credential arrives and scopes all data to the email's
household.
```

b. `docs/setup.md`: add a section `## 32b.io session auth` documenting: `SESSION_SECRET` is the same value as the www.32b.io Pages secret (a copy lives in `~/ws/32b/.dev.vars`); set it with `npx wrangler secret put SESSION_SECRET` **before** deploying the route; the `baby.32b.io` custom domain comes from `wrangler.jsonc` `routes`; `/welcome` is the onboarding entry; invites live in the `invites` table (migration 0004).

c. `docs/architecture.md`: in the auth section, describe the two identity sources (`src/identity.ts`: Access JWT → sess cookie → `DEV_USER_EMAIL`) and the invite-based onboarding flow (`src/onboard.ts`, no silent provisioning).

- [ ] **Step 5: Commit**

```bash
git add wrangler.jsonc docs/setup.md docs/architecture.md README.md
git commit -m "feat(ops): route baby.32b.io + docs for 32b.io session auth"
```

- [ ] **Step 6: Production secret, deploy, verify**

```bash
# 1. The production secret FIRST (paste the www.32b.io Pages SESSION_SECRET;
#    a copy lives in ~/ws/32b/.dev.vars). This alone doesn't expose anything —
#    the route only goes live with the next deploy.
npx wrangler secret put SESSION_SECRET

# 2. Deploy via CI: push main (pipeline: migrations → worker → alexa models).
git push
```

Then verify, in order:
1. `https://baby.llera.eu/app` still works exactly as before (Access login, existing data). Check the dashboard that the llera.eu custom domain is still attached (declaring `routes` must not have detached it).
2. The MCP connector in claude.ai still answers (`get_profile`).
3. Browser, logged in at `www.32b.io`: `https://baby.32b.io/app` shows **your existing household** (your email is already in `users`).
4. Incognito: `baby.32b.io/app` → 302 to the 32b.io login; complete a magic-link login with a test email → `/welcome` → create a household → the app loads with one unnamed baby.
5. From your own session, invite the test email's twin scenario in reverse if desired; confirm the pending row + revoke × in Settings → caregivers.

**Rollback:** remove the `routes` entry and redeploy (baby.32b.io detaches; llera.eu/Access path is untouched throughout).

---

## Out of scope (later rollout steps)

- Stripe / entitlements (step 2), session expiry + revocation hardening in `~/ws/32b` (step 3), the OAuth AS for MCP + Alexa account linking and moving them off llera.eu (step 4), landing page + legal (step 5). `SERVER_ORIGIN` in `src/web.ts` intentionally stays `https://baby.llera.eu` until step 4 (it only brands the MCP server card, and MCP stays on llera.eu for now).
