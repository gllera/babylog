# Alexa Account Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alexa users log in with their 32b.io account: babylog fronts a mini authorization server for Amazon's account-linking client, identity comes from the existing auth.32b.io OIDC login, and every utterance maps to the linked user's household (strict — the pinned `ALEXA_HOUSEHOLD_ID` dies).

**Architecture:** New module `src/alexa-link.ts` holds the whole mini-AS: HMAC-JWT mint/verify with a pinned `typ` per token kind, `GET /auth/alexa/authorize` (session via `readSession`, bounce through `/auth/login` when absent, auto-approve), `POST /auth/alexa/token` (Basic or body client auth, code + refresh grants, single-use codes via a D1 marker table). `src/alexa.ts` swaps `alexaBabyId`/`ALEXA_USER` for per-request token verification + `resolveTenant`. Spec: `docs/superpowers/specs/2026-08-09-alexa-account-linking-design.md`.

**Tech Stack:** jose (HS256 JWTs, already a dependency), D1, vitest, ask-cli (SMAPI, ops only).

---

### Task 1: Migration — single-use code markers

**Files:**
- Create: `migrations/0005_alexa_link_codes.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Single-use markers for Alexa account-linking authorization codes.
-- /auth/alexa/token INSERTs the code's jti on redemption; a UNIQUE conflict
-- means replay. Codes expire in 60s, rows are purged opportunistically after
-- a day, so this table never holds more than a handful of rows.
CREATE TABLE alexa_link_codes (
  jti     TEXT PRIMARY KEY,
  used_at INTEGER NOT NULL
);
```

- [ ] **Step 2: Apply locally and verify**

Run: `npm run db:migrate:local`
Expected: lists `0005_alexa_link_codes.sql` as applied.

- [ ] **Step 3: Commit**

```bash
git add migrations/0005_alexa_link_codes.sql
git commit -m "feat(alexa): single-use marker table for account-linking codes"
```

### Task 2: Token mint/verify with a pinned typ per kind

**Files:**
- Create: `src/alexa-link.ts`
- Modify: `src/types.ts` (add the four new Env fields, delete `ALEXA_HOUSEHOLD_ID`)
- Test: `test/alexa-link.test.ts`

- [ ] **Step 1: Add the Env fields**

In `src/types.ts`, in the `Env` type, add (leave `ALEXA_HOUSEHOLD_ID` in
place for now — Task 5 deletes it together with its last uses, so every
commit in between keeps a green typecheck):

```ts
  // Alexa account linking (src/alexa-link.ts): the mini-AS babylog fronts for
  // Amazon. The HMAC secret is deliberately NOT SESSION_HMAC_SECRET — rotating
  // web sessions must never unlink every Echo, and vice versa.
  ALEXA_OAUTH_HMAC_SECRET?: string;
  ALEXA_LINK_CLIENT_ID?: string;
  ALEXA_LINK_CLIENT_SECRET?: string;
  // Comma-separated exact-match redirect_uri allowlist (Amazon's vendor URLs).
  ALEXA_LINK_REDIRECTS?: string;
```

- [ ] **Step 2: Write the failing tests**

Create `test/alexa-link.test.ts`:

```ts
// The Alexa mini-AS: babylog-signed tokens for Amazon's account-linking
// client. The typ header is the wall between token kinds — every verify pins
// it, so a session cookie can never act as an Alexa token or vice versa.
import { describe, expect, it } from "vitest";
import {
  mintLinkToken,
  verifyLinkToken,
  CODE_TYP,
  ACCESS_TYP,
  REFRESH_TYP,
} from "../src/alexa-link";
import { mintSession, readSession, SESSION_COOKIE } from "../src/session";

const SECRET = "alexa-oauth-secret-32-bytes-long!!!!";
const env = { ALEXA_OAUTH_HMAC_SECRET: SECRET };
const ID = { sub: "u_01ABC", email: "ana@example.com" };

describe("link tokens", () => {
  it("round-trips each kind under its own typ", async () => {
    for (const typ of [CODE_TYP, ACCESS_TYP, REFRESH_TYP]) {
      const tok = await mintLinkToken(env, typ, ID, 60);
      expect(await verifyLinkToken(env, tok, typ)).toMatchObject(ID);
    }
  });

  it("rejects a token under any other kind's typ", async () => {
    const access = await mintLinkToken(env, ACCESS_TYP, ID, 60);
    expect(await verifyLinkToken(env, access, REFRESH_TYP)).toBeNull();
    expect(await verifyLinkToken(env, access, CODE_TYP)).toBeNull();
  });

  it("rejects a web session cookie as an Alexa token", async () => {
    const sess = await mintSession({ SESSION_HMAC_SECRET: SECRET }, ID);
    // Same HMAC key on purpose: even then the typ wall must hold.
    expect(await verifyLinkToken(env, sess, ACCESS_TYP)).toBeNull();
  });

  it("rejects an Alexa access token as a web session — the wall holds both ways", async () => {
    const access = await mintLinkToken(env, ACCESS_TYP, ID, 60);
    // Same HMAC key on purpose again; readSession pins typ bsess+jwt.
    const req = new Request("https://baby.32b.io/app", {
      headers: { Cookie: `${SESSION_COOKIE}=${access}` },
    });
    expect(await readSession(req, { SESSION_HMAC_SECRET: SECRET })).toBeNull();
  });

  it("rejects expiry and the wrong secret", async () => {
    const tok = await mintLinkToken(env, ACCESS_TYP, ID, -1);
    expect(await verifyLinkToken(env, tok, ACCESS_TYP)).toBeNull();
    const other = await mintLinkToken(
      { ALEXA_OAUTH_HMAC_SECRET: "a-completely-different-32-byte-key!!" },
      ACCESS_TYP,
      ID,
      60
    );
    expect(await verifyLinkToken(env, other, ACCESS_TYP)).toBeNull();
  });

  it("keeps extra claims (redirect_uri, jti) for codes", async () => {
    const tok = await mintLinkToken(env, CODE_TYP, ID, 60, {
      redirect_uri: "https://layla.amazon.com/api/skill/link/V123",
      jti: "j1",
    });
    const got = await verifyLinkToken(env, tok, CODE_TYP);
    expect(got?.redirect_uri).toBe("https://layla.amazon.com/api/skill/link/V123");
    expect(got?.jti).toBe("j1");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/alexa-link.test.ts`
Expected: FAIL — `src/alexa-link` does not exist.

- [ ] **Step 4: Implement the token core**

Create `src/alexa-link.ts`:

```ts
// -----------------------------------------------------------------------------
// Alexa account linking: the mini authorization server babylog fronts for
// exactly one client — Amazon.
//
// Why this exists at all: auth.32b.io's access tokens live 10 minutes and it
// issues no refresh tokens, while Alexa stores a token at link time and
// replays it for months. So babylog runs the OIDC login it already has
// (src/oidc.ts) to establish WHO, then wraps that identity in tokens it can
// verify locally — the same move as __Host-bsess, for a channel the IdP
// cannot serve. Identity never originates here.
//
// The HMAC secret is ALEXA_OAUTH_HMAC_SECRET, deliberately distinct from
// SESSION_HMAC_SECRET: rotating web sessions must never unlink every Echo,
// and unlinking Alexa must never sign the web out. The typ header is the
// wall between token kinds and is pinned on every verify.
// -----------------------------------------------------------------------------

import { SignJWT, jwtVerify } from "jose";
import type { Env } from "./types";
import { readSession } from "./session";

const ISSUER = "https://baby.32b.io";

export const CODE_TYP = "alexacode+jwt";
export const ACCESS_TYP = "alexatk+jwt";
export const REFRESH_TYP = "alexart+jwt";

export const CODE_TTL_S = 60;
export const ACCESS_TTL_S = 24 * 60 * 60;
// Amazon re-links only when refresh fails; make that a rare event.
export const REFRESH_TTL_S = 400 * 24 * 60 * 60;

type LinkEnv = Pick<
  Env,
  | "DB"
  | "SESSION_HMAC_SECRET"
  | "ALEXA_OAUTH_HMAC_SECRET"
  | "ALEXA_LINK_CLIENT_ID"
  | "ALEXA_LINK_CLIENT_SECRET"
  | "ALEXA_LINK_REDIRECTS"
>;

export type LinkClaims = {
  sub: string;
  email: string;
  redirect_uri?: string;
  jti?: string;
};

const keyOf = (secret: string): Uint8Array => new TextEncoder().encode(secret);

export async function mintLinkToken(
  env: Pick<Env, "ALEXA_OAUTH_HMAC_SECRET">,
  typ: string,
  id: { sub: string; email: string },
  ttlSeconds: number,
  extra: Record<string, string> = {}
): Promise<string> {
  return new SignJWT({ email: id.email, ...extra })
    .setProtectedHeader({ alg: "HS256", typ })
    .setSubject(id.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(keyOf(env.ALEXA_OAUTH_HMAC_SECRET!));
}

export async function verifyLinkToken(
  env: Pick<Env, "ALEXA_OAUTH_HMAC_SECRET">,
  token: string,
  typ: string
): Promise<LinkClaims | null> {
  if (!env.ALEXA_OAUTH_HMAC_SECRET) return null;
  try {
    const { payload } = await jwtVerify(token, keyOf(env.ALEXA_OAUTH_HMAC_SECRET), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      typ,
      requiredClaims: ["iss", "iat", "exp", "sub"],
    });
    if (typeof payload.email !== "string" || !payload.email) return null;
    return {
      sub: String(payload.sub),
      email: payload.email.toLowerCase(),
      redirect_uri:
        typeof payload.redirect_uri === "string" ? payload.redirect_uri : undefined,
      jti: typeof payload.jti === "string" ? payload.jti : undefined,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/alexa-link.test.ts && npm run typecheck`
Expected: PASS (6 tests), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/alexa-link.ts src/types.ts test/alexa-link.test.ts
git commit -m "feat(alexa): link-token core — HMAC JWTs with a pinned typ per kind"
```

### Task 3: The authorize endpoint

**Files:**
- Modify: `src/alexa-link.ts` (append)
- Test: `test/alexa-link.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `test/alexa-link.test.ts`:

```ts
import { handleAlexaAuthorize } from "../src/alexa-link";

const REDIRECT = "https://layla.amazon.com/api/skill/link/V123";
const authorizeEnv = {
  SESSION_HMAC_SECRET: "session-secret-32-bytes-long!!!!!!!!",
  ALEXA_OAUTH_HMAC_SECRET: SECRET,
  ALEXA_LINK_CLIENT_ID: "alexa",
  ALEXA_LINK_REDIRECTS: `https://pitangui.amazon.com/api/skill/link/V123,${REDIRECT}`,
} as never;

const authorizeUrl = (over: Record<string, string> = {}) => {
  const u = new URL("https://baby.32b.io/auth/alexa/authorize");
  const params = {
    response_type: "code",
    client_id: "alexa",
    redirect_uri: REDIRECT,
    state: "st-1",
    ...over,
  };
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.toString();
};

describe("handleAlexaAuthorize", () => {
  it("400 with no Location for an unknown client or unregistered redirect", async () => {
    for (const bad of [
      authorizeUrl({ client_id: "evil" }),
      authorizeUrl({ redirect_uri: "https://evil.example/cb" }),
      authorizeUrl({ redirect_uri: REDIRECT + "/" }), // exact match only
    ]) {
      const res = await handleAlexaAuthorize(new Request(bad), authorizeEnv);
      expect(res.status).toBe(400);
      expect(res.headers.get("Location")).toBeNull();
    }
  });

  it("redirects a wrong response_type back to Amazon as an OAuth error", async () => {
    const res = await handleAlexaAuthorize(
      new Request(authorizeUrl({ response_type: "token" })),
      authorizeEnv
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("error")).toBe("unsupported_response_type");
    expect(loc.searchParams.get("state")).toBe("st-1");
  });

  it("bounces a sessionless browser through /auth/login with next", async () => {
    const res = await handleAlexaAuthorize(new Request(authorizeUrl()), authorizeEnv);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!, "https://baby.32b.io");
    expect(loc.pathname).toBe("/auth/login");
    const next = loc.searchParams.get("next")!;
    expect(next.startsWith("/auth/alexa/authorize?")).toBe(true);
    expect(new URL("https://baby.32b.io" + next).searchParams.get("state")).toBe("st-1");
  });

  it("auto-approves a live session: 302 to Amazon with a redeemable code", async () => {
    const sess = await mintSession(
      { SESSION_HMAC_SECRET: (authorizeEnv as { SESSION_HMAC_SECRET: string }).SESSION_HMAC_SECRET },
      ID
    );
    const res = await handleAlexaAuthorize(
      new Request(authorizeUrl(), { headers: { Cookie: `${SESSION_COOKIE}=${sess}` } }),
      authorizeEnv
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe("st-1");
    const code = loc.searchParams.get("code")!;
    const claims = await verifyLinkToken(authorizeEnv, code, CODE_TYP);
    expect(claims).toMatchObject({ ...ID, redirect_uri: REDIRECT });
    expect(claims?.jti).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/alexa-link.test.ts`
Expected: FAIL — `handleAlexaAuthorize` is not exported.

- [ ] **Step 3: Implement the authorize handler**

Append to `src/alexa-link.ts`:

```ts
// --------------------------------------------------------------- authorize --

const registeredRedirects = (env: LinkEnv): string[] =>
  (env.ALEXA_LINK_REDIRECTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// GET /auth/alexa/authorize — Amazon sends the user's browser here to link.
// Client and redirect_uri are validated FIRST, against exact strings, and a
// failure is a 400 with no Location header: redirecting an unvalidated URI is
// the open-redirect OAuth forbids (RFC 6749 §4.1.2.1). After that, errors go
// back to Amazon as OAuth error codes. No consent page on purpose: the AS and
// the product are the same thing, and the IdP's own consent already governed
// releasing the email to babylog.
export async function handleAlexaAuthorize(
  request: Request,
  env: LinkEnv
): Promise<Response> {
  const url = new URL(request.url);
  const q = url.searchParams;

  if (
    q.get("client_id") !== env.ALEXA_LINK_CLIENT_ID ||
    !env.ALEXA_LINK_CLIENT_ID ||
    !registeredRedirects(env).includes(q.get("redirect_uri") ?? "")
  ) {
    return new Response("Unknown client or redirect_uri.", { status: 400 });
  }
  const redirectUri = q.get("redirect_uri")!;
  const state = q.get("state") ?? "";

  const errorBack = (error: string): Response => {
    const to = new URL(redirectUri);
    to.searchParams.set("error", error);
    if (state) to.searchParams.set("state", state);
    return Response.redirect(to.toString(), 302);
  };

  if (q.get("response_type") !== "code") return errorBack("unsupported_response_type");

  const session = await readSession(request, env);
  if (!session) {
    const next = encodeURIComponent(url.pathname + url.search);
    return Response.redirect(`${url.origin}/auth/login?next=${next}`, 302);
  }

  const code = await mintLinkToken(env, CODE_TYP, session, CODE_TTL_S, {
    redirect_uri: redirectUri,
    jti: crypto.randomUUID(),
  });
  const to = new URL(redirectUri);
  to.searchParams.set("code", code);
  if (state) to.searchParams.set("state", state);
  return Response.redirect(to.toString(), 302);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/alexa-link.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/alexa-link.ts test/alexa-link.test.ts
git commit -m "feat(alexa): /auth/alexa/authorize — session-gated, exact-redirect, auto-approve"
```

### Task 4: The token endpoint

**Files:**
- Modify: `src/alexa-link.ts` (append)
- Test: `test/alexa-link.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `test/alexa-link.test.ts`:

```ts
import { handleAlexaToken } from "../src/alexa-link";

// A D1 stand-in for the single-use marker table: INSERT throws on a repeated
// jti (UNIQUE), DELETE (the opportunistic purge) is a no-op.
function fakeCodesDb() {
  const seen = new Set<string>();
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (sql.startsWith("INSERT")) {
                const jti = String(args[0]);
                if (seen.has(jti)) throw new Error("UNIQUE constraint failed");
                seen.add(jti);
              }
              return {};
            },
          };
        },
      };
    },
  } as never;
}

const CLIENT_SECRET = "amazon-client-secret-32-bytes!!!!!!!";
const tokenEnv = () =>
  ({
    ...(authorizeEnv as object),
    ALEXA_LINK_CLIENT_SECRET: CLIENT_SECRET,
    DB: fakeCodesDb(),
  }) as never;

const basic = (id: string, secret: string) =>
  "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");

const tokenReq = (body: Record<string, string>, auth?: string) =>
  new Request("https://baby.32b.io/auth/alexa/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(auth ? { Authorization: auth } : {}),
    },
    body: new URLSearchParams(body).toString(),
  });

const mintCode = (over: Record<string, string> = {}) =>
  mintLinkToken(env, CODE_TYP, ID, 60, {
    redirect_uri: REDIRECT,
    jti: crypto.randomUUID(),
    ...over,
  });

describe("handleAlexaToken", () => {
  it("401 invalid_client with WWW-Authenticate on a wrong secret", async () => {
    const res = await handleAlexaToken(
      tokenReq({ grant_type: "authorization_code", code: await mintCode(), redirect_uri: REDIRECT }, basic("alexa", "wrong")),
      tokenEnv()
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Basic");
    expect((await res.json() as { error: string }).error).toBe("invalid_client");
  });

  it("exchanges a code for a verifiable pair — Basic and body auth both work", async () => {
    for (const useBasic of [true, false]) {
      const body: Record<string, string> = {
        grant_type: "authorization_code",
        code: await mintCode(),
        redirect_uri: REDIRECT,
        ...(useBasic ? {} : { client_id: "alexa", client_secret: CLIENT_SECRET }),
      };
      const res = await handleAlexaToken(
        tokenReq(body, useBasic ? basic("alexa", CLIENT_SECRET) : undefined),
        tokenEnv()
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const tok = (await res.json()) as {
        access_token: string; token_type: string; expires_in: number; refresh_token: string;
      };
      expect(tok.token_type).toBe("Bearer");
      expect(tok.expires_in).toBe(24 * 60 * 60);
      expect(await verifyLinkToken(env, tok.access_token, ACCESS_TYP)).toMatchObject(ID);
      expect(await verifyLinkToken(env, tok.refresh_token, REFRESH_TYP)).toMatchObject(ID);
    }
  });

  it("invalid_grant on replay, redirect_uri mismatch, and an expired code", async () => {
    const environment = tokenEnv();
    const code = await mintCode();
    const good = () =>
      tokenReq({ grant_type: "authorization_code", code, redirect_uri: REDIRECT }, basic("alexa", CLIENT_SECRET));
    expect((await handleAlexaToken(good(), environment)).status).toBe(200);
    const replay = await handleAlexaToken(good(), environment);
    expect(replay.status).toBe(400);
    expect((await replay.json() as { error: string }).error).toBe("invalid_grant");

    const mismatch = await handleAlexaToken(
      tokenReq(
        { grant_type: "authorization_code", code: await mintCode(), redirect_uri: "https://pitangui.amazon.com/api/skill/link/V123" },
        basic("alexa", CLIENT_SECRET)
      ),
      tokenEnv()
    );
    expect((await mismatch.json() as { error: string }).error).toBe("invalid_grant");

    const expired = await handleAlexaToken(
      tokenReq(
        { grant_type: "authorization_code", code: await mintLinkToken(env, CODE_TYP, ID, -1, { redirect_uri: REDIRECT, jti: "x" }), redirect_uri: REDIRECT },
        basic("alexa", CLIENT_SECRET)
      ),
      tokenEnv()
    );
    expect((await expired.json() as { error: string }).error).toBe("invalid_grant");
  });

  it("rotates on refresh: a new pair, and the old access token's claims carry over", async () => {
    const refresh = await mintLinkToken(env, REFRESH_TYP, ID, 60);
    const res = await handleAlexaToken(
      tokenReq({ grant_type: "refresh_token", refresh_token: refresh }, basic("alexa", CLIENT_SECRET)),
      tokenEnv()
    );
    expect(res.status).toBe(200);
    const tok = (await res.json()) as { access_token: string; refresh_token: string };
    expect(await verifyLinkToken(env, tok.access_token, ACCESS_TYP)).toMatchObject(ID);
    expect(await verifyLinkToken(env, tok.refresh_token, REFRESH_TYP)).toMatchObject(ID);
    expect(tok.refresh_token).not.toBe(refresh);
  });

  it("unsupported_grant_type for anything else", async () => {
    const res = await handleAlexaToken(
      tokenReq({ grant_type: "password" }, basic("alexa", CLIENT_SECRET)),
      tokenEnv()
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("unsupported_grant_type");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/alexa-link.test.ts`
Expected: FAIL — `handleAlexaToken` is not exported.

- [ ] **Step 3: Implement the token handler**

Append to `src/alexa-link.ts`:

```ts
// ------------------------------------------------------------------- token --

// Constant-time comparison. crypto.subtle.timingSafeEqual is a Workers
// extension vitest's Node runtime lacks, so XOR the bytes by hand; the length
// check short-circuits, which leaks only the length.
function secretsEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

const oauthError = (
  error: string,
  status: number,
  extraHeaders: Record<string, string> = {}
): Response =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });

// The client's credentials, from HTTP Basic or the form body — the Alexa
// console offers both schemes, so both are accepted.
function clientAuth(request: Request, form: URLSearchParams): { id: string; secret: string } | null {
  const header = request.headers.get("Authorization");
  if (header?.startsWith("Basic ")) {
    try {
      const [id, ...rest] = atob(header.slice(6)).split(":");
      return { id, secret: rest.join(":") };
    } catch {
      return null;
    }
  }
  const id = form.get("client_id");
  const secret = form.get("client_secret");
  return id && secret ? { id, secret } : null;
}

// POST /auth/alexa/token — Amazon redeems codes and refreshes tokens here,
// server-to-server. Every response is JSON with Cache-Control: no-store
// (RFC 6749 §5.1/§5.2).
export async function handleAlexaToken(request: Request, env: LinkEnv): Promise<Response> {
  const form = new URLSearchParams(await request.text());

  const creds = clientAuth(request, form);
  if (
    !creds ||
    !env.ALEXA_LINK_CLIENT_SECRET ||
    creds.id !== env.ALEXA_LINK_CLIENT_ID ||
    !secretsEqual(creds.secret, env.ALEXA_LINK_CLIENT_SECRET)
  ) {
    return oauthError("invalid_client", 401, {
      "WWW-Authenticate": 'Basic realm="https://baby.32b.io/auth/alexa/token"',
    });
  }

  const grant = form.get("grant_type");

  if (grant === "authorization_code") {
    const claims = await verifyLinkToken(env, form.get("code") ?? "", CODE_TYP);
    if (!claims || !claims.jti) return oauthError("invalid_grant", 400);
    // §4.1.3 substitution defence: the redemption names the same redirect_uri
    // the code was issued for.
    if (claims.redirect_uri !== form.get("redirect_uri")) {
      return oauthError("invalid_grant", 400);
    }
    // Single use: first redemption INSERTs the jti, a replay hits UNIQUE.
    try {
      await env.DB!.prepare(
        "INSERT INTO alexa_link_codes (jti, used_at) VALUES (?, ?)"
      ).bind(claims.jti, Date.now()).run();
    } catch {
      return oauthError("invalid_grant", 400);
    }
    // Opportunistic purge; codes live 60s, so a day-old marker defends nothing.
    await env.DB!.prepare("DELETE FROM alexa_link_codes WHERE used_at < ?")
      .bind(Date.now() - 86_400_000)
      .run();
    return tokenPair(env, claims);
  }

  if (grant === "refresh_token") {
    const claims = await verifyLinkToken(env, form.get("refresh_token") ?? "", REFRESH_TYP);
    if (!claims) return oauthError("invalid_grant", 400);
    // Rotation: a fresh pair every time. The old refresh token simply ages out
    // via its own exp — no reuse-detection state for a single confidential
    // client (the spec's explicit v1 scope).
    return tokenPair(env, claims);
  }

  return oauthError("unsupported_grant_type", 400);
}

async function tokenPair(env: LinkEnv, id: { sub: string; email: string }): Promise<Response> {
  return new Response(
    JSON.stringify({
      access_token: await mintLinkToken(env, ACCESS_TYP, id, ACCESS_TTL_S),
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: await mintLinkToken(env, REFRESH_TYP, id, REFRESH_TTL_S),
    }),
    {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/alexa-link.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add src/alexa-link.ts test/alexa-link.test.ts
git commit -m "feat(alexa): /auth/alexa/token — code + rotating refresh grants for Amazon"
```

### Task 5: Strict identity in the Alexa handler + routes

**Files:**
- Modify: `src/alexa.ts`
- Modify: `src/alexa-i18n.ts`
- Modify: `src/index.ts`
- Modify: `src/types.ts` (delete `ALEXA_HOUSEHOLD_ID`)
- Test: `test/alexa.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `test/alexa.test.ts`:

```ts
import { handleAlexa } from "../src/alexa";
import { mintLinkToken, ACCESS_TYP } from "../src/alexa-link";

const OAUTH_SECRET = "alexa-oauth-secret-32-bytes-long!!!!";

// The strict gate needs no DB when it refuses, so an empty stand-in is enough
// for the refusal paths; the registered-user path gets a tenant-shaped fake.
const strictEnv = (db: unknown) =>
  ({
    DB: db,
    ALEXA_SKIP_SIGNATURE: "true",
    ALEXA_OAUTH_HMAC_SECRET: OAUTH_SECRET,
  }) as never;

const envelope = (over: Record<string, unknown> = {}) => ({
  version: "1.0",
  context: {
    System: {
      application: { applicationId: "amzn1.ask.skill.test" },
      user: { userId: "u1", ...over },
    },
  },
  request: {
    type: "LaunchRequest",
    requestId: "r1",
    timestamp: new Date().toISOString(),
    locale: "en-US",
  },
});

const post = (body: unknown) =>
  new Request("https://baby.32b.io/alexa", {
    method: "POST",
    body: JSON.stringify(body),
  });

describe("strict account linking", () => {
  it("no token → LinkAccount card, localized speech, session ends", async () => {
    const res = await handleAlexa(post(envelope()), strictEnv({}));
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      response: { card?: { type: string }; outputSpeech?: { text?: string }; shouldEndSession: boolean };
    };
    expect(out.response.card?.type).toBe("LinkAccount");
    expect(out.response.outputSpeech?.text).toContain("link your account");
    expect(out.response.shouldEndSession).toBe(true);
  });

  it("an invalid/expired token behaves like no token", async () => {
    const stale = await mintLinkToken(
      { ALEXA_OAUTH_HMAC_SECRET: OAUTH_SECRET },
      ACCESS_TYP,
      { sub: "u_1", email: "ana@example.com" },
      -1
    );
    const res = await handleAlexa(post(envelope({ accessToken: stale })), strictEnv({}));
    const out = (await res.json()) as { response: { card?: { type: string } } };
    expect(out.response.card?.type).toBe("LinkAccount");
  });

  it("a linked email with no users row gets the invite line, not a crash", async () => {
    const tok = await mintLinkToken(
      { ALEXA_OAUTH_HMAC_SECRET: OAUTH_SECRET },
      ACCESS_TYP,
      { sub: "u_1", email: "nobody@example.com" },
      60
    );
    // resolveTenant does one SELECT and finds nothing.
    const db = {
      prepare: () => ({ bind: () => ({ first: async () => null }) }),
    };
    const res = await handleAlexa(post(envelope({ accessToken: tok })), strictEnv(db));
    const out = (await res.json()) as {
      response: { card?: { type: string }; outputSpeech?: { text?: string } };
    };
    expect(out.response.card).toBeUndefined();
    expect(out.response.outputSpeech?.text).toContain("isn't in a household");
  });

  it("the Spanish voice localizes the link prompt", async () => {
    const body = envelope();
    (body.request as { locale: string }).locale = "es-ES";
    const res = await handleAlexa(post(body), strictEnv({}));
    const out = (await res.json()) as { response: { outputSpeech?: { text?: string } } };
    expect(out.response.outputSpeech?.text).toContain("vincula tu cuenta");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/alexa.test.ts`
Expected: FAIL — the handler still records into `ALEXA_HOUSEHOLD_ID` without a token (no LinkAccount card).

- [ ] **Step 3: Add the two voice lines**

In `src/alexa-i18n.ts`, add to the `Voice` interface (in the launch/meta strings block):

```ts
  linkAccount: string;
  notInHousehold: string;
```

In the Spanish voice object:

```ts
  linkAccount:
    "Para usar la skill, vincula tu cuenta de 32b punto io en la app de Alexa.",
  notInHousehold:
    "Tu cuenta aún no está en ningún hogar. Acepta tu invitación en baby punto 32b punto io.",
```

In the English voice object:

```ts
  linkAccount: "To use this skill, link your account in the Alexa app.",
  notInHousehold:
    "Your account isn't in a household yet. Accept your invite at baby dot 32b dot io.",
```

- [ ] **Step 4: Make the handler strict**

In `src/alexa.ts`:

1. Delete `ALEXA_HOUSEHOLD_ID?: string;` from **both** `AlexaEnv`
   (`src/alexa.ts`) and `Env` (`src/types.ts`); add
   `ALEXA_OAUTH_HMAC_SECRET?: string;` to `AlexaEnv`.
2. Delete `ALEXA_USER`, `alexaBabyId`, and the comment block above them
   (lines 41–49). Import at the top:

```ts
import { verifyLinkToken, ACCESS_TYP } from "./alexa-link";
import { resolveTenant, pickBaby } from "./users";
```

   (`pickBaby`/`getBabies` imports: keep whichever the file already has,
   drop `getBabies` if now unused.)
3. Extend the card union in `AlexaResponseEnvelope`:

```ts
    card?:
      | { type: "Simple"; title: string; content: string }
      | { type: "LinkAccount" };
```

4. In `handleAlexa`, after the timestamp check and `const lang = langOf(...)`,
   resolve identity strictly (the envelope's token → email → household):

```ts
  const voice = VOICES[lang];

  const accessToken =
    envelope.context?.System.user.accessToken ?? envelope.session?.user.accessToken;
  const linked = accessToken
    ? await verifyLinkToken(env, accessToken, ACCESS_TYP)
    : null;
  if (!linked) {
    // Strict: no linked account, no data. The LinkAccount card puts the link
    // button in the user's Alexa app.
    return alexaJson({
      version: "1.0",
      response: {
        outputSpeech: { type: "PlainText", text: voice.linkAccount },
        card: { type: "LinkAccount" },
        shouldEndSession: true,
      },
    });
  }
  const tenant = await resolveTenant(env.DB, linked.email);
  if (!tenant) {
    // No silent provisioning — same invariant as the web and MCP.
    return alexaJson({
      version: "1.0",
      response: {
        outputSpeech: { type: "PlainText", text: voice.notInHousehold },
        shouldEndSession: true,
      },
    });
  }
  const babyId = pickBaby(tenant.babies).id;
  const user = tenant.email;
```

   (`alexaJson` = however the file already serializes `AlexaResponseEnvelope`
   responses — reuse the existing helper; if responses are built inline, add
   `const alexaJson = (body: AlexaResponseEnvelope) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });`
   near the other helpers. Check `VOICES` is imported — `langOf` already is.)
5. Thread `babyId` and `user` into the intent handlers: every function that
   called `await alexaBabyId(env)` takes `babyId: number` as a parameter
   instead, and every `ALEXA_USER` argument becomes `user` (the linked email —
   entries are now attributed to the person who spoke, not the literal
   `'alexa'`). The call sites are the handlers around lines 561, 634, 675,
   703, 765 — mechanical threading from `handleAlexa`'s dispatch.

- [ ] **Step 5: Wire the routes**

In `src/index.ts`, import:

```ts
import { handleAlexaAuthorize, handleAlexaToken } from "./alexa-link";
```

and add, directly after the `/auth/logout` block (staying inside the
"routes that are an identity's origin" region):

```ts
    // The Alexa account-linking mini-AS (src/alexa-link.ts). Public on
    // purpose: /authorize is where the linking browser lands, /token is
    // Amazon server-to-server — neither may ever sit behind Access.
    if (url.pathname === "/auth/alexa/authorize") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return handleAlexaAuthorize(request, env);
    }
    if (url.pathname === "/auth/alexa/token") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return handleAlexaToken(request, env);
    }
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all suites PASS (the new strict tests included) and `tsc` is clean —
`ALEXA_HOUSEHOLD_ID` no longer exists anywhere (`grep -rn ALEXA_HOUSEHOLD_ID src test` finds nothing).

- [ ] **Step 7: Commit**

```bash
git add src/alexa.ts src/alexa-i18n.ts src/index.ts test/alexa.test.ts
git commit -m "feat(alexa)!: strict account linking — utterances map to the linked household"
```

### Task 6: Config vars + docs

**Files:**
- Modify: `wrangler.jsonc`
- Modify: `alexa-skill/README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/setup.md`

- [ ] **Step 1: Fetch the vendor-specific redirect URLs**

The three Amazon redirect URLs embed the vendor id. Get it locally:

```bash
cd ~/ws/babylog && npx ask-cli@2 smapi get-vendor-list 2>/dev/null || echo "ask-cli not configured locally — read the redirect URLs off the skill console's Account Linking page instead"
```

The URLs are `https://pitangui.amazon.com/api/skill/link/{vendorId}`,
`https://layla.amazon.com/api/skill/link/{vendorId}`,
`https://alexa.amazon.co.jp/api/skill/link/{vendorId}`. (The console's
Account Linking page lists exactly these three — copy them verbatim if in
doubt; exact-match means exact.)

- [ ] **Step 2: Add the vars**

In `wrangler.jsonc` `vars`, after the OIDC block:

```jsonc
    // --- Alexa account linking (src/alexa-link.ts) --------------------------
    // The mini-AS babylog fronts for Amazon. Non-secret halves live here for
    // the same reason as the OIDC pair above: deploys overwrite dashboard
    // vars. The secrets (ALEXA_OAUTH_HMAC_SECRET, ALEXA_LINK_CLIENT_SECRET)
    // are wrangler secrets.
    "ALEXA_LINK_CLIENT_ID": "alexa",
    "ALEXA_LINK_REDIRECTS": "https://pitangui.amazon.com/api/skill/link/<VENDOR_ID>,https://layla.amazon.com/api/skill/link/<VENDOR_ID>,https://alexa.amazon.co.jp/api/skill/link/<VENDOR_ID>"
```

with `<VENDOR_ID>` replaced by the real value from Step 1 — never commit the
placeholder.

- [ ] **Step 3: Update the docs**

- `alexa-skill/README.md`: add an **Account linking** section after the
  endpoint-wiring note: strict linking is live — the skill answers nothing
  until the Amazon account is linked (Alexa app → skill → Settings → Link
  Account, which runs the auth.32b.io login); the AS is
  `/auth/alexa/{authorize,token}` on baby.32b.io; unlinked utterances get the
  LinkAccount card; entries are attributed to the linked user's email
  (previously the literal `alexa`).
- `docs/architecture.md`: in the identity-sources list, add the third
  source: `3. **Alexa link token** — /alexa only. A babylog-minted HMAC JWT
  (typ alexatk+jwt) from the account-linking mini-AS (src/alexa-link.ts),
  verified locally; identity originates from the same auth.32b.io OIDC
  login.` And update the "Alexa endpoint has no Access identity" paragraph:
  the transport gate (Access service token via the Lambda) is unchanged, but
  the Worker now resolves a per-user identity from the envelope's
  accessToken.
- `docs/setup.md`: in the secrets list of the "32b.io OIDC auth" section,
  mention the two Alexa secrets exist and where they're used (one line each);
  add the SMAPI account-linking step (Task 7 Step 2's command) to the
  operational notes.

- [ ] **Step 4: Typecheck (wrangler.jsonc is load-bearing), run tests, commit**

Run: `npm test && npm run typecheck`
Expected: PASS.

```bash
git add wrangler.jsonc alexa-skill/README.md docs/architecture.md docs/setup.md
git commit -m "docs(alexa): account-linking vars, setup and architecture notes"
```

### Task 7: Ops — secrets, SMAPI, deploy, live verify

**Files:** none (operations). Order matters: secrets → push (deploy) → SMAPI → link.

- [ ] **Step 1: Set the two secrets** (before the code that reads them deploys)

```bash
cd ~/ws/babylog
openssl rand -base64 32 | npx wrangler secret put ALEXA_OAUTH_HMAC_SECRET
openssl rand -base64 32 > /tmp/claude-1000/-home-gllera-ws-babylog/19eb959c-7021-45f6-86f6-05e8102060f3/scratchpad/alexa-link-client-secret
npx wrangler secret put ALEXA_LINK_CLIENT_SECRET < /tmp/claude-1000/-home-gllera-ws-babylog/19eb959c-7021-45f6-86f6-05e8102060f3/scratchpad/alexa-link-client-secret
```

(The client secret is kept in the scratchpad only until Step 3 hands it to
SMAPI, then the file is deleted.)

- [ ] **Step 2: Push — CI migrates D1 and deploys the Worker**

```bash
git push origin main && gh run watch --exit-status $(gh run list --workflow ci.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: run succeeds (migrations → worker → alexa models). From this moment
unlinked devices get the link prompt — the accepted strict-mode window until
Step 4.

- [ ] **Step 3: Configure account linking via SMAPI**

```bash
npx ask-cli@2 smapi update-account-linking-info --help
```

Read the exact flag shape, then submit Auth Code Grant with:
`authorizationUrl=https://baby.32b.io/auth/alexa/authorize`,
`accessTokenUrl=https://baby.32b.io/auth/alexa/token`, `clientId=alexa`,
`clientSecret=<the scratchpad value>`, `accessTokenScheme=HTTP_BASIC`,
skill id `amzn1.ask.skill.effc5ede-64f1-4aa8-9bab-d9755f70fb2c`, stage
`development`. Verify with `smapi get-account-linking-info` (the secret is
not echoed back — presence of the URLs is the check), then:

```bash
rm /tmp/claude-1000/-home-gllera-ws-babylog/19eb959c-7021-45f6-86f6-05e8102060f3/scratchpad/alexa-link-client-secret
```

- [ ] **Step 4: Live probes + the human link dance**

```bash
curl -sD - -o /dev/null "https://baby.32b.io/auth/alexa/authorize?response_type=code&client_id=alexa&redirect_uri=https://layla.amazon.com/api/skill/link/<VENDOR_ID>&state=probe" | grep -i "^HTTP\|^location"
curl -s -X POST https://baby.32b.io/auth/alexa/token -d "grant_type=authorization_code" | head -c 200
```

Expected: authorize → `302` with `location: /auth/login?next=…` (public —
NOT an Access 403); token → `{"error":"invalid_client"}`. Then the part only
a human can do: Alexa app → the skill → Settings → **Link Account** → the
auth.32b.io login → confirm the app shows "linked"; say one utterance
("Alexa, open baby log" → "one twenty") and check the entry lands in `/app`
attributed to the linked email — while `npx wrangler tail` watches for the
real cause if anything answers wrong.

- [ ] **Step 5: Update the memory index if lessons surfaced**

If any step deviated from this plan (SMAPI flag shape, Access surprises,
Amazon quirks), record the delta in the session summary for the user.
