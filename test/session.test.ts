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

  it("getSessionEmail returns null for a validly-signed token with no email", async () => {
    const tok = await makeToken(SECRET, { t: "sess" });
    const req = new Request("https://baby.32b.io/app", {
      headers: { Cookie: `sess=${tok}` },
    });
    expect(await getSessionEmail(req, SECRET)).toBeNull();
  });

  it("rejects a token whose body was swapped for another payload", async () => {
    const tok = await makeToken(SECRET, { t: "sess", e: "a@b.c" });
    const [, sig] = tok.split(".");
    const other = await makeToken(SECRET, { t: "sess", e: "other@example.com" });
    const [otherBody] = other.split(".");
    const forged = `${otherBody}.${sig}`;
    expect(await readToken(SECRET, forged, "sess")).toBeNull();
  });
});
