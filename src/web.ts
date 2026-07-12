// -----------------------------------------------------------------------------
// Web layer: the browser app shell (src/app.html) and its static assets.
// Authentication is handled entirely by Cloudflare Access in front of
// baby.llera.eu — the Worker no longer runs its own /app login.
// -----------------------------------------------------------------------------

import appHtmlRaw from "./app.html";

export const SERVER_ORIGIN = "https://baby.llera.eu";

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
    "Log feedings, diapers, routines, weights, and heights.",
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

// ---- App shell ---------------------------------------------------------------

const APP_HTML = appHtmlRaw;

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

export async function handleAppHome(request: Request): Promise<Response> {
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
