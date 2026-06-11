// -----------------------------------------------------------------------------
// Web layer: the OAuth consent page, the /app login + session-cookie auth, and
// the browser app shell (src/app.html) with its static assets.
// -----------------------------------------------------------------------------

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./types";
import appHtmlRaw from "./app.html";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export const SERVER_ORIGIN = "https://baby-feeding-mcp.llera.workers.dev";

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect x="18" y="20" width="28" height="38" rx="6" fill="#fff" stroke="#0070f3" stroke-width="3"/>
  <path d="M 21 36 H 43 V 53 a 3 3 0 0 1 -3 3 H 24 a 3 3 0 0 1 -3 -3 Z" fill="#0070f3" opacity="0.35"/>
  <rect x="22" y="14" width="20" height="8" rx="2" fill="#fff" stroke="#0070f3" stroke-width="3"/>
  <path d="M 26 14 Q 26 6 32 6 Q 38 6 38 14" fill="#fff" stroke="#0070f3" stroke-width="3" stroke-linecap="round"/>
  <line x1="40" y1="28" x2="44" y2="28" stroke="#0070f3" stroke-width="2"/>
  <line x1="40" y1="38" x2="44" y2="38" stroke="#0070f3" stroke-width="2"/>
  <line x1="40" y1="48" x2="44" y2="48" stroke="#0070f3" stroke-width="2"/>
</svg>`;

export const WEB_MANIFEST = JSON.stringify({
  name: "Baby diary",
  short_name: "Baby diary",
  description:
    "Log feedings, diapers, routines, weights, heights, and notes.",
  start_url: "/app",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  background_color: "#fafafa",
  theme_color: "#0070f3",
  lang: "en",
  icons: [
    {
      src: "/icon.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any",
    },
    {
      src: "/icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ],
  shortcuts: [
    {
      name: "Log feeding",
      url: "/app#feedings",
      icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    },
    {
      name: "Log diaper",
      url: "/app#diapers",
      icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    },
    {
      name: "Log routine",
      url: "/app#routines",
      icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    },
  ],
});

// Minimal pass-through service worker. Its presence (plus a fetch listener)
// is what some browsers — Opera Mobile included — still check for to enable
// "Install app" / standalone mode. We intentionally do not cache anything:
// auth cookies, MCP tokens and live diary data don't mix with stale caches.
export const SERVICE_WORKER_JS = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
`;

// -----------------------------------------------------------------------------
// OAuth: a single shared password gates access.
// `SHARED_SECRET` is a wrangler secret. Anyone with it can authorize an MCP
// client; once approved, the client gets a normal OAuth bearer token.
// -----------------------------------------------------------------------------

function renderConsent(
  clientName: string,
  state: string,
  error?: string
): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize ${escapeHtml(clientName)}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         max-width:420px;margin:60px auto;padding:24px;line-height:1.5}
    .card{border:1px solid #ddd;border-radius:8px;padding:28px;
          box-shadow:0 2px 8px rgba(0,0,0,.06)}
    h1{margin:0 0 12px;font-size:1.25rem}
    label{display:block;margin:18px 0 6px;font-weight:600}
    input[type=password]{width:100%;padding:10px;border:1px solid #ccc;
          border-radius:4px;font-size:16px;box-sizing:border-box}
    button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:4px;
           background:#0070f3;color:#fff;font-size:16px;cursor:pointer}
    .err{background:#fee;border:1px solid #fcc;color:#900;padding:10px;
         border-radius:4px;margin-top:14px;font-size:14px}
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize <em>${escapeHtml(clientName)}</em></h1>
    <p>This MCP client wants to access the baby diary.</p>
    <form method="POST" action="/authorize">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <label for="pw">Server password</label>
      <input id="pw" type="password" name="password" autocomplete="current-password" autofocus required>
      ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: error ? 401 : 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function handleAuthorizeGet(
  request: Request,
  env: Env
): Promise<Response> {
  const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  if (!client) {
    return new Response("Invalid client_id", { status: 400 });
  }
  const state = btoa(JSON.stringify(oauthReq));
  return renderConsent(client.clientName ?? "MCP Client", state);
}

export async function handleAuthorizePost(
  request: Request,
  env: Env
): Promise<Response> {
  const form = await request.formData();
  const state = form.get("state");
  const password = form.get("password");

  if (typeof state !== "string") {
    return new Response("Missing state", { status: 400 });
  }
  if (typeof password !== "string") {
    return new Response("Missing password", { status: 400 });
  }
  if (!env.SHARED_SECRET) {
    return new Response(
      "Server not configured: run `wrangler secret put SHARED_SECRET`.",
      { status: 500, headers: { "Content-Type": "text/plain" } }
    );
  }

  let oauthReq: AuthRequest;
  try {
    oauthReq = JSON.parse(atob(state)) as AuthRequest;
  } catch {
    return new Response("Invalid state", { status: 400 });
  }

  if (password !== env.SHARED_SECRET) {
    const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
    return renderConsent(
      client?.clientName ?? "MCP Client",
      state,
      "Incorrect password."
    );
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: "owner",
    metadata: { label: "Baby feeding tracker" },
    scope: oauthReq.scope,
    props: { user: "owner" },
  });
  return Response.redirect(redirectTo, 302);
}

// -----------------------------------------------------------------------------
// Web app: a browser-based UI for registering and removing entries.
// Auth is a single-password login (the same SHARED_SECRET) that issues an
// HttpOnly session cookie. The cookie value is HMAC-SHA256(SHARED_SECRET, "v1")
// so the server can verify it by recomputing — no session store needed.
// -----------------------------------------------------------------------------

const SESSION_COOKIE = "bf_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// The token is a pure function of the secret, so cache it per isolate
// instead of redoing the HMAC on every authorized request.
let sessionTokenCache: { secret: string; token: string } | null = null;

async function deriveSessionToken(secret: string): Promise<string> {
  if (sessionTokenCache?.secret === secret) return sessionTokenCache.token;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode("bf-app-session-v1")
  );
  const token = btoa(String.fromCharCode(...new Uint8Array(sig)));
  sessionTokenCache = { secret, token };
  return token;
}

function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function isWebAuthorized(
  request: Request,
  env: Env
): Promise<boolean> {
  if (!env.SHARED_SECRET) return false;
  const cookies = parseCookies(request.headers.get("Cookie"));
  const token = cookies.get(SESSION_COOKIE);
  if (!token) return false;
  const expected = await deriveSessionToken(env.SHARED_SECRET);
  return constantTimeEqual(token, expected);
}

// An empty token with maxAge 0 clears the cookie.
function sessionCookieHeader(
  token: string,
  isHttps: boolean,
  maxAge = SESSION_MAX_AGE
): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (isHttps) parts.push("Secure");
  return parts.join("; ");
}

function renderAppLogin(error?: string, next?: string): Response {
  const nextAttr = next ? `<input type="hidden" name="next" value="${escapeHtml(next)}">` : "";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Baby diary — Log in</title>
  <link rel="icon" href="/icon.svg">
  <link rel="manifest" href="/manifest.webmanifest">
  <meta name="theme-color" content="#0070f3" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#101214" media="(prefers-color-scheme: dark)">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="Baby diary">
  <link rel="apple-touch-icon" href="/icon-180.png">
  <style>
    :root{color-scheme:light dark;
      --bg:#fff;--card:#fff;--border:#ddd;--text:#222;--muted:#666;--field:#fff}
    @media (prefers-color-scheme:dark){
      :root{--bg:#101214;--card:#1a1d21;--border:#2e3338;--text:#e6e6e6;
            --muted:#9ba3ab;--field:#14171a}
    }
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         max-width:420px;margin:60px auto;padding:24px;line-height:1.5;
         color:var(--text);background:var(--bg)}
    .card{border:1px solid var(--border);border-radius:8px;padding:28px;
          box-shadow:0 2px 8px rgba(0,0,0,.06);background:var(--card)}
    h1{margin:0 0 12px;font-size:1.25rem}
    label{display:block;margin:18px 0 6px;font-weight:600}
    input[type=password]{width:100%;padding:10px;border:1px solid var(--border);
          border-radius:4px;font-size:16px;box-sizing:border-box;
          background:var(--field);color:var(--text)}
    button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:4px;
           background:#0070f3;color:#fff;font-size:16px;cursor:pointer}
    .err{background:#fee;border:1px solid #fcc;color:#900;padding:10px;
         border-radius:4px;margin-top:14px;font-size:14px}
    p{color:var(--muted);font-size:14px;margin:6px 0 0}
  </style>
</head>
<body>
  <div class="card">
    <h1>Baby diary</h1>
    <p>Log in to record feedings, diapers, routines, weights, heights, and notes.</p>
    <form method="POST" action="/app/login">
      ${nextAttr}
      <label for="pw">Password</label>
      <input id="pw" type="password" name="password" autocomplete="current-password" autofocus required>
      ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
      <button type="submit">Log in</button>
    </form>
  </div>
  <script>
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
      });
    }
  </script>
</body>
</html>`;
  return new Response(html, {
    status: error ? 401 : 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return "/app";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/app";
  return raw;
}

export async function handleAppLoginGet(request: Request): Promise<Response> {
  const next = new URL(request.url).searchParams.get("next");
  return renderAppLogin(undefined, safeNextPath(next));
}

export async function handleAppLoginPost(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.SHARED_SECRET) {
    return new Response(
      "Server not configured: run `wrangler secret put SHARED_SECRET`.",
      { status: 500, headers: { "Content-Type": "text/plain" } }
    );
  }
  const form = await request.formData();
  const password = form.get("password");
  const next = safeNextPath(form.get("next") as string | null);
  if (typeof password !== "string") {
    return renderAppLogin("Password is missing.", next);
  }
  if (password !== env.SHARED_SECRET) {
    return renderAppLogin("Incorrect password.", next);
  }
  const token = await deriveSessionToken(env.SHARED_SECRET);
  const isHttps = new URL(request.url).protocol === "https:";
  return new Response(null, {
    status: 303,
    headers: {
      Location: next,
      "Set-Cookie": sessionCookieHeader(token, isHttps),
    },
  });
}

export function handleAppLogout(request: Request): Response {
  const isHttps = new URL(request.url).protocol === "https:";
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/app/login",
      "Set-Cookie": sessionCookieHeader("", isHttps, 0),
    },
  });
}

// ---- App shell ---------------------------------------------------------------

const WHEN_BLOCK = `          <input type="hidden" name="when" value="">
          <div class="when-display" data-when-display>Now</div>
          <div class="when-quick">
            <button type="button" data-step="-60">&minus;1h</button>
            <button type="button" data-step="-15">&minus;15m</button>
            <button type="button" data-step="-5">&minus;5m</button>
            <button type="button" data-now>Now</button>
            <button type="button" data-step="5">+5m</button>
            <button type="button" data-step="15">+15m</button>
          </div>`;

const APP_HTML = appHtmlRaw.split("<!-- WHEN_BLOCK -->").join(WHEN_BLOCK);

// ETag of the app shell, computed once per isolate (the HTML is a build-time
// constant). `no-cache` + ETag lets repeat opens revalidate with a 304 instead
// of re-downloading the whole shell, while still always hitting the server —
// so a stale session keeps redirecting to login and deploys show up at once.
let appEtagCache: string | null = null;

async function appEtag(): Promise<string> {
  if (appEtagCache) return appEtagCache;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(APP_HTML)
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  appEtagCache = `"${hex.slice(0, 32)}"`;
  return appEtagCache;
}

// Cloudflare's edge may weaken the ETag (W/"…") when it compresses the body,
// so compare ignoring the weak prefix.
function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .some((t) => t.trim().replace(/^W\//, "") === etag);
}

export async function handleAppHome(
  request: Request,
  env: Env
): Promise<Response> {
  if (!(await isWebAuthorized(request, env))) {
    return new Response(null, {
      status: 303,
      headers: { Location: "/app/login?next=/app" },
    });
  }
  const etag = await appEtag();
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-cache",
    ETag: etag,
  };
  if (etagMatches(request.headers.get("If-None-Match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(APP_HTML, { headers });
}
