import type { Env } from "./types";
import { BabyFeedingMCP } from "./tools";
import { handleAlexa } from "./alexa";
import { handleApi } from "./api";
import { PNG_ICONS } from "./icons";
import { getAccessEmail } from "./access";
import {
  ICON_SVG,
  WEB_MANIFEST,
  SERVICE_WORKER_JS,
  handleAppHome,
} from "./web";

// The Durable Object class must be exported from the Worker entry module.
export { BabyFeedingMCP };

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
    // policy, stamping `Cf-Access-Jwt-Assertion`. We verify that JWT (so the
    // endpoint can't be reached via any origin Access doesn't front) and read
    // its email claim — the identity every MCP tool scopes its data to,
    // handed to the Durable Object via ctx.props.
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      const email = await getAccessEmail(request, env);
      if (!email) return new Response("Unauthorized", { status: 401 });
      // workers-types declares ExecutionContext.props readonly; McpAgent
      // reads props from the execution context, so assign through a cast.
      (ctx as { props?: Record<string, unknown> }).props = { email };
      return MCP_HANDLER.fetch(request, env, ctx);
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
