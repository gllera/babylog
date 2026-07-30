// -----------------------------------------------------------------------------
// Self-service onboarding: /welcome. A logged-in email with no users row lands
// here (index.ts gates /app) and takes exactly one of two explicit paths —
// accept a pending invite, or create a new household. There is deliberately
// no third path: silent provisioning would split one family into two tenants
// (see resolveTenant's comment in users.ts).
// -----------------------------------------------------------------------------

import type { Env } from "./types";
import {
  acceptInvite,
  createHouseholdForEmail,
  declineInvite,
  listInvitesForEmail,
  resolveTenant,
  type InviteRow,
} from "./users";

const LOGIN_URL = "https://www.32b.io/login";

// 302 to the 32b.io magic-link login, returning here afterwards (`next` is
// validated to *.32b.io by www's safeNext, so this survives open-redirect
// scrutiny on both ends).
export function loginRedirect(url: URL): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${LOGIN_URL}?next=${encodeURIComponent(url.toString())}`,
    },
  });
}

// Cross-site form posts are rejected. Two independent signals: browsers send
// an Origin header on cross-origin POSTs (same-origin posts carry our own
// origin), and modern ones also send Sec-Fetch-Site. Either mismatching
// rejects; both absent (curl, very old browsers) is allowed — the sess
// cookie's SameSite=Lax is the remaining layer there.
function crossOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== url.origin) return true;
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin" && site !== "none") return true;
  return false;
}

type Lang = "en" | "es";

const STR: Record<Lang, Record<string, string>> = {
  en: {
    title: "Welcome",
    signedInAs: "Signed in as",
    invitesIntro: "You have been invited to join:",
    invitedBy: "invited by",
    household: "household",
    accept: "Join",
    decline: "Decline",
    orCreate: "Or start your own:",
    createIntro: "Create a household for your family. Caregivers you invite later will share the same diary.",
    nameLabel: "Household name (optional)",
    create: "Create household",
  },
  es: {
    title: "Bienvenido",
    signedInAs: "Sesión iniciada como",
    invitesIntro: "Te han invitado a unirte a:",
    invitedBy: "invitación de",
    household: "hogar",
    accept: "Unirme",
    decline: "Rechazar",
    orCreate: "O crea el tuyo:",
    createIntro: "Crea un hogar para tu familia. Los cuidadores que invites después compartirán el mismo diario.",
    nameLabel: "Nombre del hogar (opcional)",
    create: "Crear hogar",
  },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Squared, hairline, elder-friendly — the app's design language, server-side.
function renderWelcome(
  email: string,
  invites: InviteRow[],
  lang: Lang,
  error?: string
): string {
  const s = STR[lang];
  const inviteBlocks = invites
    .map((inv) => {
      const label = escapeHtml(inv.household_name || `${s.household} #${inv.household_id}`);
      const by = inv.invited_by
        ? `<div class="sub">${s.invitedBy} ${escapeHtml(inv.invited_by)}</div>`
        : "";
      return `<form method="post" class="invite">
        <input type="hidden" name="invite_id" value="${inv.id}">
        <div class="grow"><div>${label}</div>${by}</div>
        <button type="submit" name="action" value="accept" class="primary">${s.accept}</button>
        <button type="submit" name="action" value="decline">${s.decline}</button>
      </form>`;
    })
    .join("");
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${s.title} — babylog</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: system-ui, sans-serif; font-size: 18px; color: #111;
         background: #fafafa; display: flex; justify-content: center; padding: 24px 16px; }
  main { width: 100%; max-width: 28rem; }
  h1 { font-size: 28px; margin: 16px 0 4px; }
  .who { color: #666; margin-bottom: 24px; overflow-wrap: anywhere; }
  section { border: 1px solid #ddd; background: #fff; padding: 20px; margin-bottom: 20px; }
  .lead { margin-bottom: 16px; }
  .sub { color: #666; font-size: 15px; }
  .invite { display: flex; align-items: center; gap: 10px; padding: 12px 0;
            border-top: 1px solid #eee; }
  .invite:first-of-type { border-top: 0; padding-top: 0; }
  .grow { flex: 1 1 auto; min-width: 0; }
  label { display: block; margin-bottom: 6px; }
  input[type=text] { width: 100%; font-size: 18px; padding: 12px; border: 1px solid #ccc;
                     background: #fff; margin-bottom: 16px; }
  button { font-size: 18px; min-height: 56px; padding: 0 20px; border: 1px solid #0070f3;
           background: #fff; color: #0070f3; cursor: pointer; }
  button.primary { background: #0070f3; color: #fff; width: 100%; }
  .invite button { min-height: 48px; width: auto; }
  .error { border: 1px solid #d33; color: #d33; background: #fff;
           padding: 12px 16px; margin-bottom: 20px; }
</style>
</head>
<body>
<main>
  <h1>${s.title}</h1>
  <div class="who">${s.signedInAs} ${escapeHtml(email)}</div>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
  ${invites.length ? `<section><div class="lead">${s.invitesIntro}</div>${inviteBlocks}</section>
  <div class="lead sub">${s.orCreate}</div>` : ""}
  <section>
    <div class="lead">${s.createIntro}</div>
    <form method="post">
      <input type="hidden" name="action" value="create">
      <label for="name">${s.nameLabel}</label>
      <input type="text" id="name" name="name" maxlength="100" autocomplete="off">
      <button type="submit" class="primary">${s.create}</button>
    </form>
  </section>
</main>
</body>
</html>`;
}

function page(html: string): Response {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    },
  });
}

function see(url: URL, path: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: new URL(path, url).toString() },
  });
}

// GET renders; POST handles create/accept/decline. A caller that already has
// a household is always bounced to /app (nothing here applies to them).
export async function handleWelcome(
  request: Request,
  env: Env,
  url: URL,
  email: string
): Promise<Response> {
  const lang: Lang = (request.headers.get("Accept-Language") || "")
    .toLowerCase()
    .startsWith("es")
    ? "es"
    : "en";
  const tenant = await resolveTenant(env.DB, email);
  if (tenant) return see(url, "/app");
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return page(renderWelcome(email, await listInvitesForEmail(env.DB, email), lang));
  }
  if (method === "POST") {
    if (crossOrigin(request, url)) return new Response("Forbidden", { status: 403 });
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    const action = String(form.get("action") || "");
    if (action === "create") {
      const name = String(form.get("name") || "").trim().slice(0, 100);
      const res = await createHouseholdForEmail(env.DB, email, name || undefined);
      if (!res.ok) {
        return page(
          renderWelcome(email, await listInvitesForEmail(env.DB, email), lang, res.message)
        );
      }
      return see(url, "/app");
    }
    if (action === "accept" || action === "decline") {
      const id = parseInt(String(form.get("invite_id") || ""), 10);
      if (!Number.isFinite(id) || id <= 0) return see(url, "/welcome");
      if (action === "accept") {
        const res = await acceptInvite(env.DB, email, id);
        if (!res.ok) {
          return page(
            renderWelcome(email, await listInvitesForEmail(env.DB, email), lang, res.message)
          );
        }
        return see(url, "/app");
      }
      await declineInvite(env.DB, email, id);
      return see(url, "/welcome");
    }
    return new Response("Bad request", { status: 400 });
  }
  return new Response("Method not allowed", { status: 405 });
}
