// -----------------------------------------------------------------------------
// JSON API for the web app: /api/<entity>[/<id>]. Cloudflare Access fronts
// baby.llera.eu; the Worker additionally verifies the Access JWT it stamps
// and reads its email claim — with tenants, identity is load-bearing, so the
// Worker can't rely on fronting alone. One generic handler serves every
// entity; the per-entity differences (table, value columns, create schema,
// extra list filters) live in the ENTITIES config below.
// -----------------------------------------------------------------------------

import { z } from "zod";
import type { BabyRow, Env } from "./types";
import {
  MAX_FEEDING_ML,
  buildWindowClauses,
  escapeLike,
  isValidIsoDate,
  madridDateOf,
  madridDayWindow,
  normalizeTs,
  recordFeeding,
} from "./lib";
import {
  buildIndicationStatement,
  extractIndicationActual,
  indicationUnit,
  type IndicationRow,
} from "./tools";
import {
  estimateWeightG,
  estimateHeightCm,
  ageDaysAt,
  resolveIndicationTarget,
  type WeightSample,
  type HeightSample,
} from "./growth";
import { getAccessEmail } from "./access";
import {
  addBaby,
  addCaregiver,
  listCaregivers,
  pickBaby,
  removeCaregiver,
  removeBaby,
  resolveTenant,
  notRegisteredMessage,
  updateBaby,
  type Tenant,
} from "./users";

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

// The web client appends ?baby=<id> once a baby is selected. Reads fall back
// to the default baby when the ref is stale (e.g. localStorage surviving a DB
// change) so the app self-heals; writes stay strict and 400.
function selectBaby(
  tenant: Tenant,
  url: URL,
  strict: boolean
): { ok: true; baby: BabyRow } | { ok: false; resp: Response } {
  const ref = url.searchParams.get("baby") ?? undefined;
  try {
    return { ok: true, baby: pickBaby(tenant.babies, ref) };
  } catch (e) {
    if (!strict && ref !== undefined) {
      try {
        return { ok: true, baby: pickBaby(tenant.babies) };
      } catch {
        /* no babies at all — fall through to the error */
      }
    }
    return {
      ok: false,
      resp: jsonError(400, e instanceof Error ? e.message : String(e)),
    };
  }
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
  // Schema for PUT edits, when it must differ from create. Feedings cap a *new*
  // amount at MAX_FEEDING_ML to catch typos, but an edit has to be able to
  // re-save a row whose stored total is already at that cap — a legacy typo row
  // from before the cap, or a value a merge clamped up to it — since the edit
  // form re-sends the stored amount even on a time-only change. Falls back to
  // createSchema when absent.
  updateSchema?: z.ZodTypeAny;
  // Replaces the generic INSERT for entities whose create has extra
  // semantics (feedings merge into a nearby entry instead of duplicating).
  create?: (
    env: Env,
    tenant: Tenant,
    baby: BabyRow,
    value: { when?: string } & Record<string, unknown>
  ) => Promise<Response>;
  // Adds entity-specific WHERE clauses from query params (kind/name/search).
  listFilter?: (
    url: URL,
    clauses: string[],
    params: (string | number)[]
  ) => void;
  // Measurement lists also carry a projected "current" value (growth.ts), so
  // the Weight/Height tabs can show "≈ now" without a second request.
  estimate?: {
    key: string;
    compute: (rows: unknown[], dob: string | null) => number | null;
  };
};

const ENTITIES: Record<string, EntityConfig> = {
  feedings: {
    table: "feedings",
    fields: ["amount_ml"],
    createSchema: z.object({
      amount_ml: z.number().positive().max(MAX_FEEDING_ML),
      when: whenField,
    }),
    // Edits skip the create-time cap so an existing at-cap row stays editable
    // (still strictly positive).
    updateSchema: z.object({
      amount_ml: z.number().positive(),
      when: whenField,
    }),
    // A feeding within 10 minutes of an existing one tops up that entry
    // (the oldest match) instead of inserting — same rule as the MCP and
    // Alexa paths. 200 + merged:true (vs 201) tells the web client to toast
    // the new total and make undo *subtract* the amount; its usual
    // delete-undo would eat the pre-existing row.
    create: async (env, tenant, baby, value) => {
      const row = await recordFeeding(
        env.DB,
        baby.id,
        tenant.email,
        normalizeTs(value.when),
        value.amount_ml as number
      );
      return jsonOk(
        { id: row.id, ts: row.ts, amount_ml: row.amount_ml, merged: row.merged },
        row.merged ? 200 : 201
      );
    },
  },
  diapers: {
    table: "diapers",
    fields: ["kind"],
    createSchema: z.object({
      kind: z.enum(["pee", "poop"]),
      when: whenField,
    }),
    listFilter: (url, clauses, params) => {
      const kind = url.searchParams.get("kind");
      if (kind && ["pee", "poop"].includes(kind)) {
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
        clauses.push("LOWER(name) LIKE ? ESCAPE '\\'");
        params.push(`%${escapeLike(name.toLowerCase())}%`);
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
    estimate: {
      key: "est_weight_g",
      compute: (rows, dob) =>
        estimateWeightG(rows as WeightSample[], new Date(), dob),
    },
  },
  heights: {
    table: "heights",
    fields: ["height_cm"],
    createSchema: z.object({
      height_cm: z.number().int().positive(),
      when: whenField,
    }),
    estimate: {
      key: "est_height_cm",
      compute: (rows, dob) =>
        estimateHeightCm(rows as HeightSample[], new Date(), dob),
    },
  },
};

async function handleEntity(
  cfg: EntityConfig,
  method: string,
  url: URL,
  idStr: string | undefined,
  request: Request,
  env: Env,
  tenant: Tenant
): Promise<Response> {
  const cols = ["id", "ts", ...cfg.fields].join(", ");

  if (method === "GET" && !idStr) {
    const sel = selectBaby(tenant, url, false);
    if (!sel.ok) return sel.resp;
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
    clauses.push("baby_id = ?");
    params.push(sel.baby.id);
    const where = `WHERE ${clauses.join(" AND ")}`;
    params.push(parseLimit(url.searchParams.get("limit")));
    const { results } = await env.DB.prepare(
      `SELECT ${cols} FROM ${cfg.table} ${where} ORDER BY ts DESC LIMIT ?`
    )
      .bind(...params)
      .all();
    const payload: Record<string, unknown> = { items: results };
    if (cfg.estimate) {
      // Estimate from the two newest rows overall — not from the list above,
      // which may be filtered to a week window by the charts.
      const recent = await env.DB.prepare(
        `SELECT ${cols} FROM ${cfg.table} WHERE baby_id = ? ORDER BY ts DESC LIMIT 2`
      )
        .bind(sel.baby.id)
        .all();
      payload[cfg.estimate.key] = cfg.estimate.compute(
        recent.results,
        sel.baby.date_of_birth
      );
    }
    return jsonOk(payload);
  }

  if (method === "POST" && !idStr) {
    const sel = selectBaby(tenant, url, true);
    if (!sel.ok) return sel.resp;
    const parsed = await readBody(request, cfg.createSchema);
    if (!parsed.ok) return jsonError(400, parsed.error);
    const value = parsed.value as Record<string, string | number> & {
      when?: string;
    };
    if (cfg.create) return cfg.create(env, tenant, sel.baby, value);
    const ts = normalizeTs(value.when);
    const placeholders = cfg.fields.map(() => "?").join(", ");
    const row = await env.DB.prepare(
      `INSERT INTO ${cfg.table} (ts, baby_id, created_by, ${cfg.fields.join(", ")}) VALUES (?, ?, ?, ${placeholders}) RETURNING ${cols}`
    )
      .bind(ts, sel.baby.id, tenant.email, ...cfg.fields.map((f) => value[f]))
      .first();
    return jsonOk(row, 201);
  }

  if (method === "PUT" && idStr) {
    const id = parseIdParam(idStr);
    if (id === null) return jsonError(400, "Invalid id.");
    const parsed = await readBody(request, cfg.updateSchema ?? cfg.createSchema);
    if (!parsed.ok) return jsonError(400, parsed.error);
    const value = parsed.value as Record<string, string | number> & {
      when?: string;
    };
    // `when` omitted means "keep the stored timestamp" (unlike POST, where it
    // means "now") — the edit form always sends it when the user changed it.
    // Rows outside the caller's household simply don't match — same "not
    // found" as a bad id, no cross-tenant existence oracle.
    const sets = cfg.fields.map((f) => `${f} = ?`);
    const params: (string | number)[] = cfg.fields.map((f) => value[f]);
    if (value.when) {
      sets.push("ts = ?");
      params.push(normalizeTs(value.when));
    }
    params.push(id, tenant.householdId);
    const row = await env.DB.prepare(
      `UPDATE ${cfg.table} SET ${sets.join(", ")}
       WHERE id = ? AND baby_id IN (SELECT id FROM babies WHERE household_id = ?)
       RETURNING ${cols}`
    )
      .bind(...params)
      .first();
    if (!row) return jsonError(404, "Not found.");
    return jsonOk(row);
  }

  if (method === "DELETE" && idStr) {
    const id = parseIdParam(idStr);
    if (id === null) return jsonError(400, "Invalid id.");
    const res = await env.DB.prepare(
      `DELETE FROM ${cfg.table}
       WHERE id = ? AND baby_id IN (SELECT id FROM babies WHERE household_id = ?)`
    )
      .bind(id, tenant.householdId)
      .run();
    if ((res.meta.changes ?? 0) === 0) return jsonError(404, "Not found.");
    return jsonOk({ deleted: id });
  }

  return jsonError(405, "Method not allowed.");
}

// Everything the Today tab needs in two D1 batches: one for the entity
// queries + active indications, then one evaluating each indication's
// actual over its own window. "Today" is the Europe/Madrid calendar day —
// the household timezone — matching the MCP tools and the Alexa skill.
async function handleDashboard(
  env: Env,
  tenant: Tenant,
  url: URL
): Promise<Response> {
  const sel = selectBaby(tenant, url, false);
  if (!sel.ok) return sel.resp;
  const babyId = sel.baby.id;

  const now = new Date();
  const nowIso = now.toISOString();
  const day = madridDateOf(now);
  const { start: dayStart, end: dayEnd } = madridDayWindow(day);
  // The strip window feeds the web app's rhythm tape. By default the tape
  // shows today plus the two previous days, and its marker-anchored
  // comparison needs feeding/diaper history well behind the marker: its
  // widest lookback is the 14-day "usual range" distribution of the days
  // *before* the marker's 24h window, i.e. up to 15 days before the marker,
  // and the marker can sit at the tape's first midnight (2 days ago) — so
  // history must reach 17 days before today's midnight. The readout's
  // jump-to-a-moment panel extends the tape further into the past and asks
  // for a deeper window via ?strip_days (tape days + that 15-day lookback).
  const stripDays = Math.min(
    400,
    Math.max(18, Math.floor(Number(url.searchParams.get("strip_days"))) || 18)
  );
  // Newest-first with a generous per-day allowance: if the cap ever binds,
  // only the window's oldest tail goes missing, never the recent tape.
  const stripLimit = Math.min(5000, stripDays * 40);
  const { start: cmpStart } = madridDayWindow(day, stripDays);
  // Gap metrics measure up to now while the day is still running.
  const gapBoundary = dayEnd < nowIso ? dayEnd : nowIso;

  const [
    recentFeedings,
    stripFeedings,
    lastDiaper,
    stripDiapers,
    stripRoutines,
    lastRoutines,
    recentWeights,
    recentHeights,
    indicationsRes,
    firstEventRes,
  ] = await env.DB.batch([
    env.DB.prepare(
      "SELECT id, ts, amount_ml FROM feedings WHERE baby_id = ? ORDER BY ts DESC LIMIT 20"
    ).bind(babyId),
    env.DB.prepare(
      "SELECT id, ts, amount_ml FROM feedings WHERE baby_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?"
    ).bind(babyId, cmpStart, stripLimit),
    env.DB.prepare(
      "SELECT id, ts, kind FROM diapers WHERE baby_id = ? ORDER BY ts DESC LIMIT 1"
    ).bind(babyId),
    env.DB.prepare(
      "SELECT id, ts, kind FROM diapers WHERE baby_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?"
    ).bind(babyId, cmpStart, stripLimit),
    env.DB.prepare(
      "SELECT id, ts, name FROM routines WHERE baby_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?"
    ).bind(babyId, cmpStart, stripLimit),
    env.DB.prepare(
      "SELECT name, MAX(ts) AS ts FROM routines WHERE baby_id = ? GROUP BY name"
    ).bind(babyId),
    env.DB.prepare(
      "SELECT id, ts, weight_g FROM weights WHERE baby_id = ? ORDER BY ts DESC LIMIT 2"
    ).bind(babyId),
    env.DB.prepare(
      "SELECT id, ts, height_cm FROM heights WHERE baby_id = ? ORDER BY ts DESC LIMIT 2"
    ).bind(babyId),
    env.DB.prepare(
      "SELECT id, label, metric, filter, target, comparison, period_days, active, formula FROM indications WHERE active = 1 AND baby_id = ? ORDER BY id"
    ).bind(babyId),
    // Earliest tape event ever — the web tape's jump dialog fences its date
    // picker to it (there is nothing to see before the first record).
    env.DB.prepare(
      "SELECT MIN(ts) AS ts FROM (SELECT MIN(ts) AS ts FROM feedings WHERE baby_id = ?1 UNION ALL SELECT MIN(ts) FROM diapers WHERE baby_id = ?1 UNION ALL SELECT MIN(ts) FROM routines WHERE baby_id = ?1)"
    ).bind(babyId),
  ]);

  // Growth-formula indications resolve their target from the baby's estimated
  // current weight and age; static indications ignore this context.
  const growthCtx = {
    estWeightG: estimateWeightG(
      recentWeights.results as unknown as WeightSample[],
      // Project weight to the civil day's start, exactly like the MCP
      // `evaluate` path (tools.ts projects to `dayStart`), NOT the live `now`.
      // A late-in-the-day `now` estimates a few grams more growth and nudges
      // the ml/kg milk target a hair higher than MCP for the same day, so the
      // two surfaces could disagree on whether milk is met.
      new Date(dayStart),
      sel.baby.date_of_birth
    ),
    // Anchor age at the civil day's UTC midnight, exactly like the MCP
    // `evaluate` path (see tools.ts), NOT at the live `now` instant. `now`
    // steps the day count at UTC midnight, so for ~1-2h after Madrid midnight
    // the Today tab would read a day short and evaluate age-tier growth
    // targets against yesterday's tier — diverging from MCP for the same day.
    ageDays: ageDaysAt(sel.baby.date_of_birth, new Date(`${day}T00:00:00Z`)),
  };

  const indications = indicationsRes.results as unknown as IndicationRow[];
  let indicationsOut: unknown[] = [];
  if (indications.length > 0) {
    // Each indication's window start is computed once and reused for both the
    // count statement and the actual extraction — the two must always span the
    // identical window or the reported "actual" wouldn't match what was counted.
    const windowStarts = indications.map(
      (ind) => madridDayWindow(day, ind.period_days).start
    );
    const actuals = await env.DB.batch(
      indications.map((ind, i) =>
        buildIndicationStatement(
          env.DB,
          ind.metric,
          ind.filter,
          windowStarts[i],
          dayEnd,
          babyId
        )
      )
    );
    indicationsOut = indications.map((ind, i) => {
      const actual = extractIndicationActual(
        ind.metric,
        actuals[i],
        gapBoundary,
        windowStarts[i]
      );
      const target = resolveIndicationTarget(ind, growthCtx);
      return {
        ...ind,
        target,
        actual,
        unit: indicationUnit(ind.metric),
        met: ind.comparison === ">=" ? actual >= target : actual <= target,
      };
    });
  }

  return jsonOk({
    day,
    day_start: dayStart,
    babies: tenant.babies,
    baby_id: babyId,
    recent_feedings: recentFeedings.results,
    strip_feedings: stripFeedings.results,
    last_diaper: lastDiaper.results[0] ?? null,
    strip_diapers: stripDiapers.results,
    strip_routines: stripRoutines.results,
    first_ts: (firstEventRes.results[0] as { ts: string | null } | undefined)?.ts ?? null,
    last_routines: lastRoutines.results,
    recent_weights: recentWeights.results,
    recent_heights: recentHeights.results,
    indications: indicationsOut,
    est_weight_g: growthCtx.estWeightG,
    est_height_cm: estimateHeightCm(
      recentHeights.results as unknown as HeightSample[],
      now,
      sel.baby.date_of_birth
    ),
  });
}

// Everything the Settings tab needs in one request: who shares the household
// and which babies it has.
async function handleHousehold(env: Env, tenant: Tenant): Promise<Response> {
  return jsonOk({
    household_id: tenant.householdId,
    me: { id: tenant.userId, email: tenant.email },
    caregivers: await listCaregivers(env.DB, tenant.householdId),
    babies: tenant.babies,
  });
}

const createBabySchema = z.object({
  name: z.string().min(1).max(100),
  sex: z.enum(["male", "female"]).optional(),
  date_of_birth: z
    .string()
    .refine(isValidIsoDate, "date_of_birth must be a real ISO date (YYYY-MM-DD).")
    .optional(),
});

async function handleBabies(
  request: Request,
  env: Env,
  tenant: Tenant
): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return jsonError(405, "Method not allowed.");
  }
  const parsed = await readBody(request, createBabySchema);
  if (!parsed.ok) return jsonError(400, parsed.error);
  const created = await addBaby(
    env.DB,
    tenant.householdId,
    tenant.babies.length,
    parsed.value
  );
  return jsonOk({ ...parsed.value, ...created }, 201);
}

// PUT /api/babies/<id> edits a baby's identity facts — sex and birth date
// gate the age line and every WHO feature, so a baby added without them
// isn't stuck. `null` clears an optional field; omitted fields keep theirs.
const updateBabySchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    sex: z.enum(["male", "female"]).nullable().optional(),
    date_of_birth: z
      .string()
      .refine(isValidIsoDate, "date_of_birth must be a real ISO date (YYYY-MM-DD).")
      .nullable()
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update." });

// DELETE /api/babies/<id> permanently removes a baby AND its whole diary
// (no FKs — see removeBaby). The web fronts it with an explicit confirm
// dialog; there is no undo.
async function handleBabyId(
  request: Request,
  env: Env,
  tenant: Tenant,
  idStr: string
): Promise<Response> {
  const method = request.method.toUpperCase();
  const id = parseIdParam(idStr);
  if (!id) return jsonError(400, "Invalid id.");
  if (method === "PUT") {
    const parsed = await readBody(request, updateBabySchema);
    if (!parsed.ok) return jsonError(400, parsed.error);
    const updated = await updateBaby(
      env.DB,
      tenant.householdId,
      id,
      parsed.value
    );
    if (!updated) return jsonError(404, `No baby #${id} in your household.`);
    return jsonOk({ ok: true, id });
  }
  if (method === "DELETE") {
    const removed = await removeBaby(env.DB, tenant.householdId, id);
    if (!removed.ok) return jsonError(404, `No baby #${id} in your household.`);
    return jsonOk({ ok: true, id, records: removed.records });
  }
  return jsonError(405, "Method not allowed.");
}

// POST /api/caregivers invites a partner; DELETE /api/caregivers/<id> removes
// one. The DB row only grants tenancy — the email must also be allowed by the
// Cloudflare Access policy (managed in Cloudflare) to reach the app at all.
async function handleCaregivers(
  request: Request,
  env: Env,
  tenant: Tenant,
  idStr: string | undefined
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "POST" && !idStr) {
    const parsed = await readBody(
      request,
      z.object({ email: z.string().email() })
    );
    if (!parsed.ok) return jsonError(400, parsed.error);
    const error = await addCaregiver(
      env.DB,
      tenant.householdId,
      parsed.value.email
    );
    if (error) return jsonError(409, error);
    return jsonOk({ email: parsed.value.email.trim().toLowerCase() }, 201);
  }
  if (method === "DELETE" && idStr) {
    const id = parseIdParam(idStr);
    if (id === null) return jsonError(400, "Invalid id.");
    const res = await removeCaregiver(env.DB, tenant, id);
    if (!res.ok) {
      return jsonError(res.code === "not_found" ? 404 : 400, res.message);
    }
    return jsonOk({ deleted: id });
  }
  return jsonError(405, "Method not allowed.");
}

// The app shell reads the selected baby's sex/DOB for the WHO percentile
// bands, plus the full list for the switcher.
function handleProfile(tenant: Tenant, url: URL): Response {
  const sel = selectBaby(tenant, url, false);
  return jsonOk({
    babies: tenant.babies,
    baby: sel.ok ? sel.baby : null,
  });
}

export async function handleApi(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  // Cloudflare Access fronts baby.llera.eu; we additionally verify the JWT it
  // stamps (and read the email) — with tenants, identity is load-bearing, so
  // the Worker can't rely on fronting alone.
  const email = await getAccessEmail(request, env);
  if (!email) return jsonError(401, "Unauthorized.");
  const tenant = await resolveTenant(env.DB, email);
  if (!tenant) return jsonError(403, notRegisteredMessage(email));

  // /api/<entity>[/<id>]
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "<entity>", "<id>?"]
  if (parts.length < 2 || parts.length > 3) return jsonError(404, "Not found.");
  if (parts[1] === "dashboard" && parts.length === 2) {
    if (request.method.toUpperCase() !== "GET") {
      return jsonError(405, "Method not allowed.");
    }
    return handleDashboard(env, tenant, url);
  }
  if (parts[1] === "profile" && parts.length === 2) {
    if (request.method.toUpperCase() !== "GET") {
      return jsonError(405, "Method not allowed.");
    }
    return handleProfile(tenant, url);
  }
  if (parts[1] === "household" && parts.length === 2) {
    if (request.method.toUpperCase() !== "GET") {
      return jsonError(405, "Method not allowed.");
    }
    return handleHousehold(env, tenant);
  }
  if (parts[1] === "babies") {
    if (parts.length === 2) return handleBabies(request, env, tenant);
    if (parts.length === 3) {
      return handleBabyId(request, env, tenant, parts[2]);
    }
    return jsonError(404, "Unknown entity.");
  }
  if (parts[1] === "caregivers") {
    return handleCaregivers(request, env, tenant, parts[2]);
  }
  const cfg = ENTITIES[parts[1]];
  if (!cfg) return jsonError(404, "Unknown entity.");
  return handleEntity(
    cfg,
    request.method.toUpperCase(),
    url,
    parts[2],
    request,
    env,
    tenant
  );
}
