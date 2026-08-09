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
