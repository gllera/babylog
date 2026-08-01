// babylog's OWN session cookie, minted after the OIDC code exchange.
//
// The suite this replaced tested the opposite thing: verifying auth.32b.io's
// estate-wide `sess` cookie (Ed25519, Domain=32b.io). babylog is an OIDC client
// now and mints its own host-only session instead, which is the whole point —
// the estate's `__Host-` flip cannot happen while any product still reads the
// shared cookie, so "the shared cookie buys nothing here" is the load-bearing
// assertion in this file rather than an afterthought.

import { describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import {
  SESSION_COOKIE,
  clearSessionCookie,
  mintSession,
  readSession,
  sessionCookie,
} from "../src/session";
import type { Env } from "../src/types";

const SECRET = "test-secret-at-least-32-bytes-long!!";
const env = { SESSION_HMAC_SECRET: SECRET } as unknown as Env;

const withCookie = (raw: string): Request =>
  new Request("https://baby.32b.io/app", { headers: { Cookie: raw } });

const req = async (e: Env = env, claims = { sub: "u_1", email: "ana@example.com" }) =>
  withCookie(`${SESSION_COOKIE}=${await mintSession(e, claims)}`);

describe("mint and read", () => {
  it("round-trips the account id and the email", async () => {
    expect(await readSession(await req(), env)).toEqual({
      sub: "u_1",
      email: "ana@example.com",
    });
  });

  it("lowercases the email on the way out", async () => {
    const r = await req(env, { sub: "u_1", email: "Ana@Example.COM" });
    expect((await readSession(r, env))?.email).toBe("ana@example.com");
  });

  it("answers null with no cookie at all", async () => {
    expect(await readSession(new Request("https://baby.32b.io/app"), env)).toBeNull();
  });
});

describe("what it refuses", () => {
  it("refuses a token signed with another secret", async () => {
    const other = { SESSION_HMAC_SECRET: "a-completely-different-secret-value!!" } as unknown as Env;
    expect(await readSession(await req(other), env)).toBeNull();
  });

  it("refuses a tampered payload", async () => {
    const tok = await mintSession(env, { sub: "u_1", email: "ana@example.com" });
    const [h, , s] = tok.split(".");
    const forged = btoa(JSON.stringify({ sub: "u_ADMIN", email: "evil@example.com" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await readSession(withCookie(`${SESSION_COOKIE}=${h}.${forged}.${s}`), env)).toBeNull();
  });

  it("refuses an expired token", async () => {
    const key = new TextEncoder().encode(SECRET);
    const now = Math.floor(Date.now() / 1000);
    const stale = await new SignJWT({ t: "sess", sub: "u_1", email: "ana@example.com" })
      .setProtectedHeader({ alg: "HS256", typ: "bsess+jwt" })
      .setIssuer("https://baby.32b.io")
      .setIssuedAt(now - 7200)
      .setExpirationTime(now - 60)
      .sign(key);
    expect(await readSession(withCookie(`${SESSION_COOKIE}=${stale}`), env)).toBeNull();
  });

  // A token minted for a different relying party is not a session here, even
  // when it verifies: one HMAC secret is only a boundary if the issuer is
  // checked too.
  it("refuses a token from another issuer", async () => {
    const key = new TextEncoder().encode(SECRET);
    const foreign = await new SignJWT({ t: "sess", sub: "u_1", email: "ana@example.com" })
      .setProtectedHeader({ alg: "HS256", typ: "bsess+jwt" })
      .setIssuer("https://evil.example")
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(key);
    expect(await readSession(withCookie(`${SESSION_COOKIE}=${foreign}`), env)).toBeNull();
  });

  it("refuses everything when the secret is unset, and says so by name", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await req();
    expect(await readSession(r, {} as Env)).toBeNull();
    expect(log.mock.calls.flat().join(" ")).toContain("SESSION_HMAC_SECRET");
    log.mockRestore();
  });
});

// The reason this repo changed at all. auth.32b.io's shared cookie is still in
// flight on 32b.io while the other products convert, so it will keep arriving
// here — and it must now buy exactly nothing. Deleting the verifier is what makes
// that true; this pins it, so a future "compatibility" branch cannot quietly
// reopen the dependency the `__Host-` flip is waiting on.
describe("the estate's shared cookie", () => {
  it("is ignored, even when it is present and well-formed", async () => {
    const shared = await new SignJWT({ t: "sess", sub: "u_1", email: "ana@example.com" })
      .setProtectedHeader({ alg: "HS256", typ: "sess+jwt" })
      .setIssuer("https://auth.32b.io")
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(new TextEncoder().encode(SECRET));
    expect(await readSession(withCookie(`sess=${shared}`), env)).toBeNull();
  });

  it("does not shadow babylog's own cookie when both are sent", async () => {
    const mine = await mintSession(env, { sub: "u_REAL", email: "real@example.com" });
    const both = withCookie(`sess=planted; ${SESSION_COOKIE}=${mine}; sess=another`);
    expect(await readSession(both, env)).toEqual({ sub: "u_REAL", email: "real@example.com" });
  });
});

describe("the cookie attributes", () => {
  it("is __Host- prefixed, so no other 32b.io host can write it", () => {
    expect(SESSION_COOKIE.startsWith("__Host-")).toBe(true);
    const c = sessionCookie("tok");
    expect(c).toContain("Path=/");
    expect(c).toContain("Secure");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    // __Host- forbids it, and that prohibition IS the property being bought.
    expect(c).not.toContain("Domain=");
  });

  it("clears with the same attributes and a zero Max-Age", () => {
    const c = clearSessionCookie();
    expect(c).toContain("Max-Age=0");
    expect(c).toContain("Path=/");
    expect(c).not.toContain("Domain=");
  });
});
