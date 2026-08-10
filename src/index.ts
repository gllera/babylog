import type { Env } from "./types";
import { BabyFeedingMCP } from "./tools";
import { handleAlexa } from "./alexa";
import { handleApi } from "./api";
import { PNG_ICONS } from "./icons";
import { getIdentityEmail } from "./identity";
import { resolveTenant } from "./users";
import { handleWelcome, loginRedirect } from "./onboard";
import { beginLogin, handleCallback, logout } from "./oidc";
import { authorizeMcp, protectedResourceMetadata } from "./mcp-auth";
import { handleAlexaAuthorize, handleAlexaToken } from "./alexa-link";
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

// The MCP transport handler. Authorization is the gate below, not the
// transport's: nothing reaches this without a verified access token.
const MCP_HANDLER = BabyFeedingMCP.serve("/mcp", { binding: "MCP_OBJECT" });

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Where an MCP client's whole login starts: RFC 9728 metadata, ahead of
    // every gate because it is what an UNAUTHENTICATED client reads to find out
    // which authorization server to go to. Two paths, one document — see
    // src/mcp-auth.ts for why both must answer.
    const metadata = protectedResourceMetadata(url, env);
    if (metadata) return metadata;

    // /mcp verifies its own OAuth 2.1 access tokens: minted by auth.32b.io,
    // audience-bound to this resource, checked in src/mcp-auth.ts. A refusal is
    // the 401 (or 403) that module builds, carrying the `WWW-Authenticate`
    // header the client discovers everything else from — never a bare 401,
    // which tells a client nothing about where to log in.
    //
    // It does NOT go through getIdentityEmail: that function answers for the
    // browser surfaces and knows only cookies. A Cloudflare Access JWT used to
    // be its other answer and used to open this endpoint; both are gone.
    //
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      const gate = await authorizeMcp(request, env);
      if (!gate.ok) return gate.response;
      // The token's email is the identity every MCP tool scopes its data to,
      // handed to the Durable Object via ctx.props. workers-types declares
      // ExecutionContext.props readonly; McpAgent reads props from the
      // execution context, so assign through a cast.
      (ctx as { props?: Record<string, unknown> }).props = { email: gate.email };
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

    // The Alexa account-linking mini-AS (src/alexa-link.ts). Public on
    // purpose: /authorize is where the linking browser lands, /token is
    // Amazon server-to-server — neither may ever sit behind Access.
    // /authorize takes GET (render the confirmation) and POST (the user
    // confirmed — mint the code); the POST-to-mint is the CSRF defence.
    if (url.pathname === "/auth/alexa/authorize") {
      if (request.method !== "GET" && request.method !== "POST") {
        return methodNotAllowed("GET, POST");
      }
      return handleAlexaAuthorize(request, env);
    }
    if (url.pathname === "/auth/alexa/token") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return handleAlexaToken(request, env);
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
    // auth.32b.io login. Identity without a household → /welcome (accept an
    // invite or create one).
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
