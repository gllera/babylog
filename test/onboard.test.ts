// Where an anonymous visitor is sent to log in.
//
// This is one constant, and getting it wrong fails in the least visible way
// available: a 302 to a URL that 404s, on the one path a new user takes before
// they have any reason to trust the app. It went untested while it pointed at
// www.32b.io — which stopped serving a login when auth.32b.io took identity over
// — so the estate's own cutover would have broken onboarding here with nothing
// to notice.
//
// It now points INSIDE this Worker: babylog is an OIDC client, so the visitor
// goes to /auth/login, which is the only thing that knows how to build an
// authorization request. Sending them straight to auth.32b.io/login would
// produce a perfectly good estate session and a cookie this Worker no longer
// reads — a login that appears to work and admits nobody.
import { describe, expect, it } from "vitest";
import { loginRedirect } from "../src/onboard";

const locationOf = (url: string) =>
  loginRedirect(new URL(url)).headers.get("location")!;

describe("loginRedirect", () => {
  it("starts the flow here, not at the IdP", () => {
    const res = loginRedirect(new URL("https://baby.32b.io/welcome"));
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    // Relative and same-origin by construction: nothing to get wrong about a
    // host, and nothing to leak to a host that is not ours.
    expect(location.startsWith("/auth/login?")).toBe(true);
    expect(location).not.toContain("auth.32b.io");
  });

  it("carries the current path as next, encoded, so the user comes back here", () => {
    const location = locationOf("https://baby.32b.io/welcome?invite=abc");
    const next = new URLSearchParams(location.split("?")[1]).get("next");
    expect(next).toBe("/welcome?invite=abc");
  });

  // safeNext on the other end only accepts a same-origin absolute path, so an
  // absolute URL here would be silently dropped and the user returned to /app
  // instead of where they were going.
  it("hands over a next that the callback's own redirect rule will accept", () => {
    const next = new URLSearchParams(locationOf("https://baby.32b.io/app").split("?")[1]).get(
      "next"
    )!;
    expect(next.startsWith("/")).toBe(true);
    expect(next.startsWith("//")).toBe(false);
  });
});
