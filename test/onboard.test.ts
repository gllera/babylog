// Where an anonymous visitor is sent to log in.
//
// This is one constant, and getting it wrong fails in the least visible way
// available: a 302 to a URL that 404s, on the one path a new user takes before
// they have any reason to trust the app. It went untested while it pointed at
// www.32b.io — which stopped serving a login when auth.32b.io took identity over
// (gllera/32b `chore/retire-www-login`), so the estate's own cutover would have
// broken onboarding here with nothing to notice.
import { describe, expect, it } from "vitest";
import { loginRedirect } from "../src/onboard";

describe("loginRedirect", () => {
  it("sends the visitor to auth.32b.io, the only host that serves a login", () => {
    const res = loginRedirect(new URL("https://baby.32b.io/welcome"));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://auth.32b.io");
    expect(location.pathname).toBe("/login");
  });

  it("carries the current URL as next, encoded, so the user comes back here", () => {
    const here = "https://baby.32b.io/welcome?invite=abc";
    const location = new URL(loginRedirect(new URL(here)).headers.get("location")!);
    // Read back through the parser rather than string-matching: what matters is
    // that auth.32b.io's safeNext sees exactly the URL we meant to hand it.
    expect(location.searchParams.get("next")).toBe(here);
  });

  // safeNext on the other end only accepts https://*.32b.io, so a login link
  // built from a non-estate origin would be silently dropped and the user
  // returned to auth's own landing page instead of here.
  it("hands over a next that the estate's own redirect rule will accept", () => {
    const location = new URL(
      loginRedirect(new URL("https://baby.32b.io/app")).headers.get("location")!
    );
    const next = new URL(location.searchParams.get("next")!);
    expect(next.protocol).toBe("https:");
    expect(next.hostname === "32b.io" || next.hostname.endsWith(".32b.io")).toBe(true);
  });
});
