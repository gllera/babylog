import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./types";
import { BabyFeedingMCP } from "./tools";
import { handleAlexa } from "./alexa";
import { handleApi } from "./api";
import { PNG_ICONS } from "./icons";
import {
  ICON_SVG,
  WEB_MANIFEST,
  SERVICE_WORKER_JS,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleAppHome,
  handleAppLoginGet,
  handleAppLoginPost,
  handleAppLogout,
} from "./web";

// The Durable Object class must be exported from the Worker entry module.
export { BabyFeedingMCP };

const defaultHandler = {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize" && request.method === "GET") {
      return handleAuthorizeGet(request, env);
    }
    if (url.pathname === "/authorize" && request.method === "POST") {
      return handleAuthorizePost(request, env);
    }
    if (url.pathname === "/icon.svg") {
      return new Response(ICON_SVG, {
        headers: {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }
    const iconMatch = url.pathname.match(/^\/icon-(180|192|512)\.png$/);
    if (iconMatch) {
      return new Response(PNG_ICONS[iconMatch[1]], {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }
    if (url.pathname === "/manifest.webmanifest") {
      return new Response(WEB_MANIFEST, {
        headers: {
          "Content-Type": "application/manifest+json; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }
    if (url.pathname === "/sw.js") {
      return new Response(SERVICE_WORKER_JS, {
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-cache",
          "Service-Worker-Allowed": "/",
        },
      });
    }
    if (url.pathname === "/app" || url.pathname === "/app/") {
      return handleAppHome(request, env);
    }
    if (url.pathname === "/app/login" && request.method === "GET") {
      return handleAppLoginGet(request);
    }
    if (url.pathname === "/app/login" && request.method === "POST") {
      return handleAppLoginPost(request, env);
    }
    if (url.pathname === "/app/logout" && request.method === "POST") {
      return handleAppLogout(request);
    }
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }
    if (url.pathname === "/alexa") {
      return handleAlexa(request, env);
    }
    if (url.pathname === "/") {
      return new Response(null, {
        status: 303,
        headers: { Location: "/app" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};

export default new OAuthProvider({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  apiRoute: "/mcp",
  apiHandler: BabyFeedingMCP.serve("/mcp", { binding: "MCP_OBJECT" }),
  // The OAuthProvider types insist on `unknown` env here; the cast is safe
  // because OAuthProvider injects `OAUTH_PROVIDER` at runtime.
  defaultHandler: defaultHandler as unknown as ExportedHandler,
});
