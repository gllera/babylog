export type Env = {
  DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
  // --- OIDC client credentials for auth.32b.io (src/oidc.ts) ---------------
  // The ONE URL this client pins. Every endpoint is read from the discovery
  // document beneath it, so the IdP can move an endpoint without a deploy here.
  // Also the issuer /mcp's access tokens must name, and the authorization
  // server its RFC 9728 metadata advertises (src/mcp-auth.ts).
  OIDC_ISSUER?: string;
  // What this application is called in the IdP's registry, and what a token's
  // `aud` must name. Public by nature — it travels in the browser's address bar.
  OIDC_CLIENT_ID?: string;
  // A secret: it authenticates this Worker at /token. Set with `wrangler secret
  // put`, never a var — a var lives in wrangler.jsonc, which is in git.
  OIDC_CLIENT_SECRET?: string;
  // The HMAC key babylog signs its OWN session cookie with (src/session.ts).
  // Also a secret, and unrelated to the estate-wide SESSION_HMAC_SECRET this repo
  // retired at the cutover: that one could forge a session anywhere on 32b.io,
  // this one only forges baby.32b.io's.
  SESSION_HMAC_SECRET?: string;
  ALEXA_APPLICATION_ID?: string;
  ALEXA_SKIP_SIGNATURE?: string;
  // Local dev only (.dev.vars): the identity assumed when no session cookie is
  // present, and only on a localhost origin. Never set in production.
  DEV_USER_EMAIL?: string;
  // Alexa account linking (src/alexa-link.ts): the mini-AS babylog fronts for
  // Amazon. The HMAC secret is deliberately NOT SESSION_HMAC_SECRET — rotating
  // web sessions must never unlink every Echo, and vice versa.
  ALEXA_OAUTH_HMAC_SECRET?: string;
  ALEXA_LINK_CLIENT_ID?: string;
  ALEXA_LINK_CLIENT_SECRET?: string;
  // Comma-separated exact-match redirect_uri allowlist (Amazon's vendor URLs).
  ALEXA_LINK_REDIRECTS?: string;
};

export type FeedingRow = {
  id: number;
  ts: string;
  amount_ml: number;
};

export type DiaperKind = "pee" | "poop";

export type DiaperRow = {
  id: number;
  ts: string;
  kind: DiaperKind;
};

export type RoutineRow = {
  id: number;
  ts: string;
  name: string;
};

export type WeightRow = {
  id: number;
  ts: string;
  weight_g: number;
};

export type HeightRow = {
  id: number;
  ts: string;
  height_cm: number;
};

export type BabyRow = {
  id: number;
  household_id: number;
  name: string | null;
  sex: "male" | "female" | null;
  date_of_birth: string | null;
  is_default: number;
};

export type UserRow = {
  id: number;
  email: string;
  household_id: number;
};
