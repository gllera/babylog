// -----------------------------------------------------------------------------
// JSON API for the web app: /api/<entity>[/<id>]. All routes require a valid
// session cookie. One generic handler serves every entity; the per-entity
// differences (table, value columns, create schema, extra list filters) live
// in the ENTITIES config below.
// -----------------------------------------------------------------------------

import { z } from "zod";
import type { Env } from "./types";
import { buildWindowClauses, normalizeTs } from "./lib";
import { isWebAuthorized } from "./web";

function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function parseLimit(raw: string | null): number {
  if (!raw) return 50;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 500);
}

function parseIdParam(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

async function readBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T
): Promise<{ ok: true; value: z.infer<T> } | { ok: false; error: string }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, error: "Invalid JSON body." };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  }
  return { ok: true, value: parsed.data };
}

const whenField = z.string().datetime({ offset: true }).optional();

type EntityConfig = {
  table: string;
  // Value columns beyond id/ts; doubles as the insert column list.
  fields: string[];
  createSchema: z.ZodTypeAny;
  // Adds entity-specific WHERE clauses from query params (kind/name/search).
  listFilter?: (
    url: URL,
    clauses: string[],
    params: (string | number)[]
  ) => void;
};

const ENTITIES: Record<string, EntityConfig> = {
  feedings: {
    table: "feedings",
    fields: ["amount_ml"],
    createSchema: z.object({
      amount_ml: z.number().positive(),
      when: whenField,
    }),
  },
  diapers: {
    table: "diapers",
    fields: ["kind"],
    createSchema: z.object({
      kind: z.enum(["pee", "poop", "both"]),
      when: whenField,
    }),
    listFilter: (url, clauses, params) => {
      const kind = url.searchParams.get("kind");
      if (kind && ["pee", "poop", "both"].includes(kind)) {
        clauses.push("kind = ?");
        params.push(kind);
      }
    },
  },
  routines: {
    table: "routines",
    fields: ["name"],
    createSchema: z.object({
      name: z.string().min(1).max(100),
      when: whenField,
    }),
    listFilter: (url, clauses, params) => {
      const name = url.searchParams.get("name");
      if (name) {
        clauses.push("LOWER(name) LIKE ?");
        params.push(`%${name.toLowerCase()}%`);
      }
    },
  },
  notes: {
    table: "notes",
    fields: ["text"],
    createSchema: z.object({
      text: z.string().min(1).max(2000),
      when: whenField,
    }),
    listFilter: (url, clauses, params) => {
      const search = url.searchParams.get("search");
      if (search) {
        clauses.push("LOWER(text) LIKE ?");
        params.push(`%${search.toLowerCase()}%`);
      }
    },
  },
  weights: {
    table: "weights",
    fields: ["weight_g"],
    createSchema: z.object({
      weight_g: z.number().int().positive(),
      when: whenField,
    }),
  },
  heights: {
    table: "heights",
    fields: ["height_cm"],
    createSchema: z.object({
      height_cm: z.number().int().positive(),
      when: whenField,
    }),
  },
};

async function handleEntity(
  cfg: EntityConfig,
  method: string,
  url: URL,
  idStr: string | undefined,
  request: Request,
  env: Env
): Promise<Response> {
  const cols = ["id", "ts", ...cfg.fields].join(", ");

  if (method === "GET" && !idStr) {
    const since = url.searchParams.get("since") ?? undefined;
    const until = url.searchParams.get("until") ?? undefined;
    if (
      (since && Number.isNaN(Date.parse(since))) ||
      (until && Number.isNaN(Date.parse(until)))
    ) {
      return jsonError(400, "Invalid since/until timestamp.");
    }
    const { clauses, params } = buildWindowClauses(since, until);
    cfg.listFilter?.(url, clauses, params);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(parseLimit(url.searchParams.get("limit")));
    const { results } = await env.DB.prepare(
      `SELECT ${cols} FROM ${cfg.table} ${where} ORDER BY ts DESC LIMIT ?`
    )
      .bind(...params)
      .all();
    return jsonOk({ items: results });
  }

  if (method === "POST" && !idStr) {
    const parsed = await readBody(request, cfg.createSchema);
    if (!parsed.ok) return jsonError(400, parsed.error);
    const value = parsed.value as Record<string, string | number> & {
      when?: string;
    };
    const ts = normalizeTs(value.when);
    const placeholders = cfg.fields.map(() => "?").join(", ");
    const row = await env.DB.prepare(
      `INSERT INTO ${cfg.table} (ts, ${cfg.fields.join(", ")}) VALUES (?, ${placeholders}) RETURNING ${cols}`
    )
      .bind(ts, ...cfg.fields.map((f) => value[f]))
      .first();
    return jsonOk(row, 201);
  }

  if (method === "DELETE" && idStr) {
    const id = parseIdParam(idStr);
    if (id === null) return jsonError(400, "Invalid id.");
    const res = await env.DB.prepare(
      `DELETE FROM ${cfg.table} WHERE id = ?`
    )
      .bind(id)
      .run();
    if ((res.meta.changes ?? 0) === 0) return jsonError(404, "Not found.");
    return jsonOk({ deleted: id });
  }

  return jsonError(405, "Method not allowed.");
}

export async function handleApi(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  if (!(await isWebAuthorized(request, env))) {
    return jsonError(401, "Unauthorized.");
  }
  // /api/<entity>[/<id>]
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "<entity>", "<id>?"]
  if (parts.length < 2 || parts.length > 3) return jsonError(404, "Not found.");
  const cfg = ENTITIES[parts[1]];
  if (!cfg) return jsonError(404, "Unknown entity.");
  return handleEntity(
    cfg,
    request.method.toUpperCase(),
    url,
    parts[2],
    request,
    env
  );
}
