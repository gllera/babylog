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
