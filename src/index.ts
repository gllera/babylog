import type { Env } from "./types";
import { BabyFeedingMCP } from "./tools";
import { handleAlexa } from "./alexa";
import { handleApi } from "./api";
import { PNG_ICONS } from "./icons";
import { getIdentityEmail } from "./identity";
import { resolveTenant } from "./users";
import { handleWelcome, loginRedirect } from "./onboard";
import { beginLogin, handleCallback, logout } from "./oidc";
import {
  ICON_SVG,
  WEB_MANIFEST,
  SERVICE_WORKER_JS,
  handleAppHome,
} from "./web";

// The Durable Object class must be exported from the Worker entry module.
export { BabyFeedingMCP };

const methodNotAllowed = (allow: string): Response =>
  new Response("Method not allowed", { status: 405, headers: { Allow: allow } });

// The MCP transport handler. Authorization is handled upstream by Cloudflare
// Access (Managed OAuth) + the Access-JWT check below, not by the Worker.
const MCP_HANDLER = BabyFeedingMCP.serve("/mcp", { binding: "MCP_OBJECT" });

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // /mcp is fronted by a Cloudflare Access app with Managed OAuth, which runs
    // the entire OAuth 2.1 flow for the MCP client (discovery, dynamic client
    // registration, login). Access only forwards a request once it passes the
    // policy, stamping `Cf-Access-Jwt-Assertion`. The Worker resolves identity
    // itself (Access JWT or 32b.io sess cookie — see identity.ts), so the
    // endpoint stays closed on any origin Access doesn't front; the resolved
    // email is the identity every MCP tool scopes its data to, handed to the
    // Durable Object via ctx.props.
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      const email = await getIdentityEmail(request, env);
      if (!email) return new Response("Unauthorized", { status: 401 });
      // workers-types declares ExecutionContext.props readonly; McpAgent
      // reads props from the execution context, so assign through a cast.
      (ctx as { props?: Record<string, unknown> }).props = { email };
      return MCP_HANDLER.fetch(request, env, ctx);
    }

    // The OIDC client's two legs plus logout. These are the only routes that
    // talk to auth.32b.io, and they are deliberately ahead of everything that
    // resolves an identity: /auth/callback is where an identity comes FROM, so
    // gating it on having one already would be a loop.
    //
    // GET only. The IdP's response_mode is `query`, so the callback is a
    // top-level navigation; logout is a GET because it takes no argument and
    // ends a session that is already the browser's own — and then hands the
    // browser on to the IdP's own logout page, which is the only place the
    // ESTATE session can be ended. See the note on BYE_COOKIE in src/oidc.ts
    // for why that redirect is not enough on its own.
    if (url.pathname === "/auth/login") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return beginLogin(request, env);
    }
    if (url.pathname === "/auth/callback") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return handleCallback(request, env);
    }
    if (url.pathname === "/auth/logout") {
      if (request.method !== "GET" && request.method !== "POST") {
        return methodNotAllowed("GET, POST");
      }
      return logout(request, env);
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
    // /app and /welcome are the two browser entry points. No identity → the
    // 32b.io magic-link login (on baby.llera.eu, Access intercepts first, so
    // this redirect only ever fires on baby.32b.io or in dev). Identity
    // without a household → /welcome (accept an invite or create one).
    if (
      url.pathname === "/app" ||
      url.pathname === "/app/" ||
      url.pathname === "/welcome" ||
      url.pathname === "/welcome/"
    ) {
      const email = await getIdentityEmail(request, env);
      if (!email) return loginRedirect(url);
      if (url.pathname === "/welcome" || url.pathname === "/welcome/") {
        return handleWelcome(request, env, url, email);
      }
      const tenant = await resolveTenant(env.DB, email);
      if (!tenant) {
        return new Response(null, { status: 303, headers: { Location: "/welcome" } });
      }
      return handleAppHome(request);
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
} satisfies ExportedHandler<Env>;
