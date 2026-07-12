// -----------------------------------------------------------------------------
// The MCP agent: a Durable Object exposing all baby-diary tools over /mcp.
// -----------------------------------------------------------------------------

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  Env,
  BabyRow,
  DiaperKind,
  FeedingRow,
  DiaperRow,
  RoutineRow,
  NoteRow,
  WeightRow,
  HeightRow,
  UserRow,
} from "./types";
import {
  DAY_MS,
  MAX_FEEDING_ML,
  computeAge,
  normalizeTs,
  formatGap,
  maxGapMinutes,
  buildWindowClauses,
  escapeLike,
  madridDateOf,
  madridMidnightUtc,
  madridDayWindow,
  insertAndLookupPrev,
  recordFeeding,
  FEEDING_MERGE_WINDOW_MIN,
} from "./lib";
import { SERVER_ORIGIN } from "./web";
import {
  GROWTH_FORMULAS,
  GROWTH_FORMULA_KEYS,
  isGrowthFormula,
  resolveIndicationTarget,
  estimateWeightG,
  ageDaysAt,
  type WeightSample,
} from "./growth";
import {
  addBaby,
  addCaregiver,
  pickBaby,
  removeCaregiver,
  resolveTenant,
  notRegisteredMessage,
  type Tenant,
} from "./users";

function formatBaby(b: BabyRow): string {
  const lines = [
    `Baby #${b.id}${b.is_default === 1 ? " (default)" : ""}`,
    `Name: ${b.name ?? "—"}`,
    `Sex:  ${b.sex ?? "—"}`,
  ];
  if (b.date_of_birth) {
    lines.push(`DOB:  ${b.date_of_birth}  (${computeAge(b.date_of_birth)})`);
  } else {
    lines.push("DOB:  —");
  }
  return lines.join("\n");
}

const INDICATION_METRICS = [
  "feeding_total_ml",
  "feeding_count",
  "feeding_gap_max_min",
  "diaper_count",
  "routine_count",
  "note_count",
] as const;
type IndicationMetric = (typeof INDICATION_METRICS)[number];
const indicationMetricSchema = z.enum(INDICATION_METRICS);
const comparisonSchema = z.enum([">=", "<="] as const);
const formulaSchema = z.enum(GROWTH_FORMULA_KEYS);

const WINDOW_OFFSET_MS = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
} as const;

const limitField = z
  .number()
  .int()
  .positive()
  .max(500)
  .optional()
  .describe("Maximum number of rows to return (default 50, max 500)");

const whenInput = (desc: string) =>
  z.string().datetime({ offset: true }).optional().describe(desc);

const babyField = z
  .string()
  .min(1)
  .max(100)
  .optional()
  .describe(
    "Which baby this applies to — a name or numeric id from get_profile. OMIT when the household has a single baby or the default baby is meant."
  );

// Suffix for record confirmations so multi-baby households see who got the
// entry; single-baby households keep the old terse output.
function forBabyNote(tenant: Tenant, baby: BabyRow): string {
  if (tenant.babies.length < 2) return "";
  return ` for ${baby.name ?? `baby #${baby.id}`}`;
}

async function deleteById(
  db: D1Database,
  table: string,
  label: string,
  id: number,
  householdId: number
) {
  // Rows outside the caller's household simply don't match — same "not
  // found" as a bad id, no cross-tenant existence oracle.
  const res = await db
    .prepare(
      `DELETE FROM ${table} WHERE id = ? AND baby_id IN (SELECT id FROM babies WHERE household_id = ?)`
    )
    .bind(id, householdId)
    .run();
  const changes = res.meta.changes ?? 0;
  return {
    content: [
      {
        type: "text" as const,
        text:
          changes > 0
            ? `Deleted ${label} #${id}.`
            : `No ${label} with id #${id} found.`,
      },
    ],
  };
}

export type IndicationRow = {
  id: number;
  label: string;
  metric: IndicationMetric;
  filter: string | null;
  target: number;
  comparison: ">=" | "<=";
  period_days: number;
  active: number;
  // Growth-formula key (see src/growth.ts). NULL → a plain static target.
  formula: string | null;
};

export function buildIndicationStatement(
  db: D1Database,
  metric: IndicationMetric,
  filter: string | null,
  start: string,
  end: string,
  babyId: number
): D1PreparedStatement {
  switch (metric) {
    case "feeding_total_ml":
      return db
        .prepare(
          "SELECT COALESCE(SUM(amount_ml), 0) AS v FROM feedings WHERE baby_id = ? AND ts >= ? AND ts < ?"
        )
        .bind(babyId, start, end);
    case "feeding_count":
      return db
        .prepare(
          "SELECT COUNT(*) AS v FROM feedings WHERE baby_id = ? AND ts >= ? AND ts < ?"
        )
        .bind(babyId, start, end);
    case "feeding_gap_max_min":
      // Also fetch the last feeding *before* the window so the gap across
      // the window start is measured (see maxGapMinutes).
      return db
        .prepare(
          `SELECT ts FROM (SELECT ts FROM feedings WHERE baby_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1)
           UNION ALL
           SELECT ts FROM feedings WHERE baby_id = ? AND ts >= ? AND ts < ? ORDER BY ts`
        )
        .bind(babyId, start, babyId, start, end);
    case "diaper_count": {
      let sql =
        "SELECT COUNT(*) AS v FROM diapers WHERE baby_id = ? AND ts >= ? AND ts < ?";
      if (filter === "pee") sql += " AND kind IN ('pee','both')";
      else if (filter === "poop") sql += " AND kind IN ('poop','both')";
      else if (filter === "both") sql += " AND kind = 'both'";
      return db.prepare(sql).bind(babyId, start, end);
    }
    case "routine_count":
      if (filter) {
        return db
          .prepare(
            "SELECT COUNT(*) AS v FROM routines WHERE baby_id = ? AND ts >= ? AND ts < ? AND LOWER(name) LIKE ? ESCAPE '\\'"
          )
          .bind(babyId, start, end, `%${escapeLike(filter.toLowerCase())}%`);
      }
      return db
        .prepare(
          "SELECT COUNT(*) AS v FROM routines WHERE baby_id = ? AND ts >= ? AND ts < ?"
        )
        .bind(babyId, start, end);
    case "note_count":
      if (filter) {
        return db
          .prepare(
            "SELECT COUNT(*) AS v FROM notes WHERE baby_id = ? AND ts >= ? AND ts < ? AND LOWER(text) LIKE ? ESCAPE '\\'"
          )
          .bind(babyId, start, end, `%${escapeLike(filter.toLowerCase())}%`);
      }
      return db
        .prepare(
          "SELECT COUNT(*) AS v FROM notes WHERE baby_id = ? AND ts >= ? AND ts < ?"
        )
        .bind(babyId, start, end);
  }
}

// `gapBoundary` is min(window end, now): gap metrics measure the trailing gap
// from the last feeding up to that instant. `windowStart` is the window's start
// instant, used only for the gap metric so a window with no feeding at all
// scores as one long gap (the whole span) instead of 0 — otherwise a never-fed
// baby would satisfy a `<=` max-gap target, the opposite of the truth.
export function extractIndicationActual(
  metric: IndicationMetric,
  result: D1Result<unknown>,
  gapBoundary: string,
  windowStart: string
): number {
  if (metric === "feeding_gap_max_min") {
    const rows = result.results as Array<{ ts: string }>;
    if (rows.length === 0) {
      return Math.max(
        0,
        Math.round((Date.parse(gapBoundary) - Date.parse(windowStart)) / 60000)
      );
    }
    return maxGapMinutes(
      rows.map((r) => r.ts),
      gapBoundary
    );
  }
  const rows = result.results as Array<{ v: number }>;
  return rows[0]?.v ?? 0;
}

export function indicationUnit(metric: IndicationMetric): string {
  if (metric === "feeding_total_ml") return "ml";
  if (metric === "feeding_gap_max_min") return "min";
  return "";
}

// ---- Tool factories ----------------------------------------------------------

type ListToolSpec<Row extends { id: number; ts: string }> = {
  name: string;
  description: string;
  table: string;
  // Key for the rows array in structuredContent, e.g. "feedings".
  resultKey: string;
  // Value columns beyond id/ts.
  cols: string[];
  rowSchema: z.ZodRawShape;
  // Noun used in the since/until descriptions, e.g. "feedings", "events".
  itemNoun: string;
  emptyText: string;
  line: (r: Row) => string;
  extra?: {
    key: string;
    schema: z.ZodTypeAny;
    apply: (
      value: string,
      clauses: string[],
      params: (string | number)[]
    ) => void;
  };
};

function registerListTool<Row extends { id: number; ts: string }>(
  server: McpServer,
  db: D1Database,
  tenant: () => Promise<Tenant>,
  spec: ListToolSpec<Row>
) {
  const inputSchema: z.ZodRawShape = {
    since: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe(`Include ${spec.itemNoun} on or after this ISO timestamp`),
    until: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe(`Include ${spec.itemNoun} strictly before this ISO timestamp`),
    ...(spec.extra ? { [spec.extra.key]: spec.extra.schema } : {}),
    baby: babyField,
    limit: limitField,
  };
  server.registerTool(
    spec.name,
    {
      description: spec.description,
      inputSchema,
      outputSchema: {
        count: z.number().int(),
        [spec.resultKey]: z.array(z.object(spec.rowSchema)),
      },
    },
    async (args: Record<string, unknown>) => {
      const t = await tenant();
      const baby = pickBaby(t.babies, args.baby as string | undefined);
      const { clauses, params } = buildWindowClauses(
        args.since as string | undefined,
        args.until as string | undefined
      );
      if (spec.extra) {
        const v = args[spec.extra.key];
        if (typeof v === "string" && v) spec.extra.apply(v, clauses, params);
      }
      clauses.push("baby_id = ?");
      params.push(baby.id);
      const where = `WHERE ${clauses.join(" AND ")}`;
      params.push((args.limit as number | undefined) ?? 50);

      const { results } = await db
        .prepare(
          `SELECT id, ts, ${spec.cols.join(", ")} FROM ${spec.table} ${where} ORDER BY ts DESC LIMIT ?`
        )
        .bind(...params)
        .all<Row>();

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: spec.emptyText }],
          structuredContent: { count: 0, [spec.resultKey]: [] },
        };
      }

      return {
        content: [
          { type: "text" as const, text: results.map(spec.line).join("\n") },
        ],
        structuredContent: { count: results.length, [spec.resultKey]: results },
      };
    }
  );
}

function registerDeleteTool(
  server: McpServer,
  db: D1Database,
  tenant: () => Promise<Tenant>,
  spec: {
    name: string;
    description: string;
    table: string;
    label: string;
    idDesc: string;
  }
) {
  server.registerTool(
    spec.name,
    {
      description: spec.description,
      inputSchema: {
        id: z.number().int().positive().describe(spec.idDesc),
      },
    },
    async ({ id }) => {
      const t = await tenant();
      return deleteById(db, spec.table, spec.label, id, t.householdId);
    }
  );
}

// record_weight / record_height are identical apart from field, unit, and text.
function registerMeasurementRecordTool(
  server: McpServer,
  db: D1Database,
  tenant: () => Promise<Tenant>,
  spec: {
    name: string;
    description: string;
    table: string;
    field: string;
    unit: string;
    label: string;
    valueDesc: string;
  }
) {
  const deltaKey = `delta_${spec.unit}`;
  const prevKey = `previous_${spec.field}`;
  server.registerTool(
    spec.name,
    {
      description: spec.description,
      inputSchema: {
        [spec.field]: z.number().int().positive().describe(spec.valueDesc),
        when: whenInput(
          "Optional ISO 8601 timestamp. OMIT this when the measurement is happening now."
        ),
        baby: babyField,
      },
      outputSchema: {
        id: z.number().int(),
        ts: z.string(),
        [spec.field]: z.number().int(),
        [deltaKey]: z.number().int().nullable(),
        previous_ts: z.string().nullable(),
        [prevKey]: z.number().int().nullable(),
      },
    },
    async (args: Record<string, unknown>) => {
      const t = await tenant();
      const baby = pickBaby(t.babies, args.baby as string | undefined);
      const value = args[spec.field] as number;
      const ts = normalizeTs(args.when as string | undefined);
      const { id, prev } = await insertAndLookupPrev<
        { ts: string } & Record<string, number | string>
      >(
        db,
        db
          .prepare(
            `SELECT ts, ${spec.field} FROM ${spec.table} WHERE baby_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1`
          )
          .bind(baby.id, ts),
        db
          .prepare(
            `INSERT INTO ${spec.table} (ts, ${spec.field}, baby_id, created_by) VALUES (?, ?, ?, ?) RETURNING id`
          )
          .bind(ts, value, baby.id, t.email)
      );

      let delta = "";
      let diff: number | null = null;
      if (prev) {
        diff = value - (prev[spec.field] as number);
        const sign = diff >= 0 ? "+" : "";
        delta = `  (${sign}${diff} ${spec.unit} since ${prev.ts})`;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Recorded ${spec.label} #${id}${forBabyNote(t, baby)}: ${value} ${spec.unit} at ${ts}${delta}.`,
          },
        ],
        structuredContent: {
          id,
          ts,
          [spec.field]: value,
          [deltaKey]: diff,
          previous_ts: prev?.ts ?? null,
          [prevKey]: prev ? (prev[spec.field] as number) : null,
        },
      };
    }
  );
}

// ---- The agent ----------------------------------------------------------------

type McpProps = { email: string };

export class BabyFeedingMCP extends McpAgent<Env, unknown, McpProps> {
  server = new McpServer({
    name: "baby-feeding-tracker",
    version: "1.0.0",
    icons: [
      {
        src: `${SERVER_ORIGIN}/icon.svg`,
        mimeType: "image/svg+xml",
        sizes: ["any"],
      },
    ],
    websiteUrl: SERVER_ORIGIN,
  });

  // Resolved fresh per tool call (two cheap indexed lookups) so caregiver /
  // baby changes apply immediately. Throwing is fine: the MCP SDK catches
  // handler errors and returns them to the client as tool errors.
  private async tenant(): Promise<Tenant> {
    const email = this.props?.email;
    if (!email) {
      throw new Error("Unauthorized: no user identity on this MCP session.");
    }
    const tenant = await resolveTenant(this.env.DB, email);
    if (!tenant) throw new Error(notRegisteredMessage(email));
    return tenant;
  }

  async init() {
    const db = this.env.DB;
    const tenant = () => this.tenant();

    this.server.registerTool(
      "set_profile",
      {
        description:
          "Update a baby's profile fields (name, sex, date of birth). Pass only the fields you want to change — others stay as they were. At least one field is required. With multiple babies, select which one via `baby`.",
        inputSchema: {
          name: z
            .string()
            .min(1)
            .max(100)
            .optional()
            .describe("Baby's name, e.g. 'Sofía'"),
          sex: z
            .enum(["male", "female"])
            .optional()
            .describe(
              "Biological sex: 'male' or 'female'. (Spanish 'niño'/'masculino' → 'male', 'niña'/'femenino' → 'female')"
            ),
          date_of_birth: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe(
              "Date of birth in ISO date format YYYY-MM-DD, e.g. '2026-04-01'"
            ),
          baby: babyField,
        },
      },
      async ({ name, sex, date_of_birth, baby }) => {
        if (
          name === undefined &&
          sex === undefined &&
          date_of_birth === undefined
        ) {
          return {
            content: [
              {
                type: "text",
                text: "Provide at least one of: name, sex, date_of_birth.",
              },
            ],
            isError: true,
          };
        }
        const t = await this.tenant();
        const target = pickBaby(t.babies, baby);

        const updates: string[] = [];
        const params: (string | null)[] = [];
        if (name !== undefined) {
          updates.push("name = ?");
          params.push(name);
        }
        if (sex !== undefined) {
          updates.push("sex = ?");
          params.push(sex);
        }
        if (date_of_birth !== undefined) {
          updates.push("date_of_birth = ?");
          params.push(date_of_birth);
        }
        updates.push("updated_at = datetime('now')");

        await db
          .prepare(`UPDATE babies SET ${updates.join(", ")} WHERE id = ?`)
          .bind(...params, target.id)
          .run();

        const row = await db
          .prepare(
            "SELECT id, household_id, name, sex, date_of_birth, is_default FROM babies WHERE id = ?"
          )
          .bind(target.id)
          .first<BabyRow>();

        return {
          content: [
            {
              type: "text",
              text: `Profile updated.\n${row ? formatBaby(row) : "(baby not found)"}`,
            },
          ],
        };
      }
    );

    this.server.registerTool(
      "get_profile",
      {
        description:
          "List the babies in the caller's household: name, sex, date of birth, computed age, and which one is the default.",
        outputSchema: {
          babies: z.array(
            z.object({
              id: z.number().int(),
              name: z.string().nullable(),
              sex: z.enum(["male", "female"]).nullable(),
              date_of_birth: z.string().nullable(),
              is_default: z.boolean(),
              age: z.string().nullable(),
              age_days: z.number().int().nullable(),
            })
          ),
        },
      },
      async () => {
        const t = await this.tenant();
        const babies = t.babies.map((b) => {
          let age: string | null = null;
          let ageDays: number | null = null;
          if (b.date_of_birth) {
            age = computeAge(b.date_of_birth);
            const birth = new Date(`${b.date_of_birth}T00:00:00Z`);
            ageDays = Math.floor((Date.now() - birth.getTime()) / DAY_MS);
          }
          return {
            id: b.id,
            name: b.name,
            sex: b.sex,
            date_of_birth: b.date_of_birth,
            is_default: b.is_default === 1,
            age,
            age_days: ageDays,
          };
        });
        const text =
          t.babies.length === 0
            ? "No babies in this household yet. Use add_baby to create one."
            : t.babies.map(formatBaby).join("\n\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { babies },
        };
      }
    );

    this.server.registerTool(
      "record_feeding",
      {
        description:
          `Record a milk feeding for the baby. If the user does not specify a time, OMIT the \`when\` parameter — the server records the feeding at the current time. Only pass \`when\` if the user gave an explicit past/future time. The response includes the gap since the previous feeding so the agent can mention it. If the time falls within ${FEEDING_MERGE_WINDOW_MIN} minutes of an existing feeding, the amount is added to that feeding (the oldest match) instead of creating a new entry — the response then has merged=true, keeps the existing entry's id/ts, and amount_ml is that entry's new total.`,
        inputSchema: {
          amount_ml: z
            .number()
            .positive()
            .max(MAX_FEEDING_ML)
            .describe("Amount of milk in milliliters, e.g. 120"),
          when: whenInput(
            "Optional ISO 8601 timestamp (e.g. 2026-05-14T07:30:00Z, or with a local offset like 2026-05-14T09:30:00+02:00 — stored as UTC). OMIT this when the feeding is happening now — the server fills in the current time. Only pass this if the user explicitly gave a different time."
          ),
          baby: babyField,
        },
        outputSchema: {
          id: z.number().int(),
          ts: z.string(),
          amount_ml: z.number(),
          merged: z.boolean(),
          gap_since_previous: z.string().nullable(),
          gap_since_previous_min: z.number().int().nullable(),
          previous_ts: z.string().nullable(),
        },
      },
      async ({ amount_ml, when, baby }) => {
        const t = await this.tenant();
        const target = pickBaby(t.babies, baby);
        const ts = normalizeTs(when);
        const row = await recordFeeding(db, target.id, t.email, ts, amount_ml);
        if (row.merged) {
          // The feed didn't create a new event, so "gap since previous"
          // doesn't apply — the merge target IS the previous feeding.
          return {
            content: [
              {
                type: "text",
                text: `Added ${amount_ml} ml to feeding #${row.id}${forBabyNote(t, target)} at ${row.ts} (within ${FEEDING_MERGE_WINDOW_MIN} min): now ${row.amount_ml} ml.`,
              },
            ],
            structuredContent: {
              id: row.id,
              ts: row.ts,
              amount_ml: row.amount_ml,
              merged: true,
              gap_since_previous: null,
              gap_since_previous_min: null,
              previous_ts: null,
            },
          };
        }
        const { gapStr, gapMin, gapNote } = formatGap(ts, row.prevTs);

        return {
          content: [
            {
              type: "text",
              text: `Recorded feeding #${row.id}${forBabyNote(t, target)}: ${amount_ml} ml at ${ts}${gapNote}.`,
            },
          ],
          structuredContent: {
            id: row.id,
            ts,
            amount_ml,
            merged: false,
            gap_since_previous: gapStr,
            gap_since_previous_min: gapMin,
            previous_ts: row.prevTs,
          },
        };
      }
    );

    registerListTool<FeedingRow>(this.server, db, tenant, {
      name: "list_feedings",
      description:
        "List recorded feedings, most recent first. Optionally filter by a time window and limit.",
      table: "feedings",
      resultKey: "feedings",
      cols: ["amount_ml"],
      rowSchema: {
        id: z.number().int(),
        ts: z.string(),
        amount_ml: z.number(),
      },
      itemNoun: "feedings",
      emptyText: "No feedings recorded in that range.",
      line: (r) => `#${r.id}  ${r.ts}  ${r.amount_ml} ml`,
    });

    registerDeleteTool(this.server, db, tenant, {
      name: "delete_feeding",
      description: "Delete a recorded feeding by its numeric id.",
      table: "feedings",
      label: "feeding",
      idDesc: "Feeding id to delete (from list_feedings)",
    });

    this.server.registerTool(
      "record_diaper",
      {
        description:
          "Record a diaper change — pee, poop, or both. If the user does not specify a time, OMIT the `when` parameter — the server records the change at the current time. Only pass `when` if the user gave an explicit past/future time. The response includes the gap since the previous diaper of any kind.",
        inputSchema: {
          kind: z
            .enum(["pee", "poop", "both"])
            .describe(
              "'pee' = wet only, 'poop' = dirty only, 'both' = wet and dirty in the same diaper"
            ),
          when: whenInput(
            "Optional ISO 8601 timestamp (e.g. 2026-05-14T07:30:00Z, or with a local offset like 2026-05-14T09:30:00+02:00 — stored as UTC). OMIT this when the change is happening now — the server fills in the current time. Only pass this if the user explicitly gave a different time."
          ),
          baby: babyField,
        },
        outputSchema: {
          id: z.number().int(),
          ts: z.string(),
          kind: z.enum(["pee", "poop", "both"]),
          gap_since_previous: z.string().nullable(),
          gap_since_previous_min: z.number().int().nullable(),
          previous_ts: z.string().nullable(),
          previous_kind: z.enum(["pee", "poop", "both"]).nullable(),
        },
      },
      async ({ kind, when, baby }) => {
        const t = await this.tenant();
        const target = pickBaby(t.babies, baby);
        const ts = normalizeTs(when);
        const { id, prev } = await insertAndLookupPrev<{
          ts: string;
          kind: DiaperKind;
        }>(
          db,
          db
            .prepare(
              "SELECT ts, kind FROM diapers WHERE baby_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1"
            )
            .bind(target.id, ts),
          db
            .prepare(
              "INSERT INTO diapers (ts, kind, baby_id, created_by) VALUES (?, ?, ?, ?) RETURNING id"
            )
            .bind(ts, kind, target.id, t.email)
        );
        const { gapStr, gapMin, gapNote } = formatGap(ts, prev?.ts ?? null);

        return {
          content: [
            {
              type: "text",
              text: `Recorded diaper #${id}${forBabyNote(t, target)}: ${kind} at ${ts}${gapNote}.`,
            },
          ],
          structuredContent: {
            id,
            ts,
            kind,
            gap_since_previous: gapStr,
            gap_since_previous_min: gapMin,
            previous_ts: prev?.ts ?? null,
            previous_kind: prev?.kind ?? null,
          },
        };
      }
    );

    registerListTool<DiaperRow>(this.server, db, tenant, {
      name: "list_diapers",
      description:
        "List diaper events, most recent first. Optionally filter by time window and kind.",
      table: "diapers",
      resultKey: "diapers",
      cols: ["kind"],
      rowSchema: {
        id: z.number().int(),
        ts: z.string(),
        kind: z.enum(["pee", "poop", "both"]),
      },
      itemNoun: "events",
      emptyText: "No diaper events in that range.",
      line: (r) => `#${r.id}  ${r.ts}  ${r.kind}`,
      extra: {
        key: "kind",
        schema: z
          .enum(["pee", "poop", "both"])
          .optional()
          .describe("Filter to only pee, only poop, or only 'both' events"),
        apply: (kind, clauses, params) => {
          clauses.push("kind = ?");
          params.push(kind);
        },
      },
    });

    registerDeleteTool(this.server, db, tenant, {
      name: "delete_diaper",
      description: "Delete a diaper event by its numeric id.",
      table: "diapers",
      label: "diaper",
      idDesc: "Diaper id to delete (from list_diapers)",
    });

    this.server.registerTool(
      "record_routine",
      {
        description:
          "Record a routine care event, medication, or supplement for the baby. This table is used for medication doses (e.g. 'Vitamin D', 'Acetaminophen') as well as routine events the user wants to track over time (e.g. 'Bath', 'Tummy' for tummy time). If the user does not specify a time, OMIT the `when` parameter — the server records the event at the current time. Only pass `when` if the user gave an explicit past/future time. The response includes the gap since the previous entry with the same `name` (case-insensitive) so the agent can space doses.",
        inputSchema: {
          name: z
            .string()
            .min(1)
            .max(100)
            .describe("Entry name, e.g. 'Vitamin D', 'Acetaminophen', 'Bath', 'Tummy'"),
          when: whenInput(
            "Optional ISO 8601 timestamp (e.g. 2026-05-14T07:30:00Z, or with a local offset like 2026-05-14T09:30:00+02:00 — stored as UTC). OMIT this when the event is happening now — the server fills in the current time."
          ),
          baby: babyField,
        },
        outputSchema: {
          id: z.number().int(),
          ts: z.string(),
          name: z.string(),
          gap_since_previous: z.string().nullable(),
          gap_since_previous_min: z.number().int().nullable(),
          previous_ts: z.string().nullable(),
        },
      },
      async ({ name, when, baby }) => {
        const t = await this.tenant();
        const target = pickBaby(t.babies, baby);
        const ts = normalizeTs(when);
        const { id, prev } = await insertAndLookupPrev<{ ts: string }>(
          db,
          db
            .prepare(
              "SELECT ts FROM routines WHERE baby_id = ? AND ts < ? AND LOWER(name) = LOWER(?) ORDER BY ts DESC LIMIT 1"
            )
            .bind(target.id, ts, name),
          db
            .prepare(
              "INSERT INTO routines (ts, name, baby_id, created_by) VALUES (?, ?, ?, ?) RETURNING id"
            )
            .bind(ts, name, target.id, t.email)
        );
        const { gapStr, gapMin, gapNote } = formatGap(ts, prev?.ts ?? null, name);

        return {
          content: [
            {
              type: "text",
              text: `Recorded routine #${id}${forBabyNote(t, target)}: ${name} at ${ts}${gapNote}.`,
            },
          ],
          structuredContent: {
            id,
            ts,
            name,
            gap_since_previous: gapStr,
            gap_since_previous_min: gapMin,
            previous_ts: prev?.ts ?? null,
          },
        };
      }
    );

    registerListTool<RoutineRow>(this.server, db, tenant, {
      name: "list_routines",
      description:
        "List routine-care entries and medication doses (e.g. Vitamin D doses, baths), most recent first. Optionally filter by time window and entry name (case-insensitive substring match).",
      table: "routines",
      resultKey: "routines",
      cols: ["name"],
      rowSchema: {
        id: z.number().int(),
        ts: z.string(),
        name: z.string(),
      },
      itemNoun: "entries",
      emptyText: "No routines recorded in that range.",
      line: (r) => `#${r.id}  ${r.ts}  ${r.name}`,
      extra: {
        key: "name",
        schema: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe(
            "Filter by entry name (case-insensitive substring match, e.g. 'vitamin')"
          ),
        apply: (name, clauses, params) => {
          clauses.push("LOWER(name) LIKE ? ESCAPE '\\'");
          params.push(`%${escapeLike(name.toLowerCase())}%`);
        },
      },
    });

    registerDeleteTool(this.server, db, tenant, {
      name: "delete_routine",
      description: "Delete a routine entry by its numeric id.",
      table: "routines",
      label: "routine",
      idDesc: "Routine id to delete (from list_routines)",
    });

    this.server.registerTool(
      "record_note",
      {
        description:
          "Record a free-form note about the baby — anything that doesn't fit feedings, diapers, routines, weights, or heights. Examples: 'pimples on the face', 'first smile', 'rash on left arm', 'fussy after nap'. If the user does not specify a time, OMIT the `when` parameter — the server uses the current time.",
        inputSchema: {
          text: z
            .string()
            .min(1)
            .max(2000)
            .describe(
              "The note itself, in the user's own words. Required."
            ),
          when: whenInput(
            "Optional ISO 8601 timestamp. OMIT this when the note is happening now — the server fills in the current time."
          ),
          baby: babyField,
        },
        outputSchema: {
          id: z.number().int(),
          ts: z.string(),
          text: z.string(),
        },
      },
      async ({ text, when, baby }) => {
        const t = await this.tenant();
        const target = pickBaby(t.babies, baby);
        const ts = normalizeTs(when);
        const inserted = await db
          .prepare(
            "INSERT INTO notes (ts, text, baby_id, created_by) VALUES (?, ?, ?, ?) RETURNING id"
          )
          .bind(ts, text, target.id, t.email)
          .first<{ id: number }>();

        const id = inserted?.id ?? 0;
        return {
          content: [
            {
              type: "text",
              text: `Recorded note #${id}${forBabyNote(t, target)} at ${ts}: ${text}`,
            },
          ],
          structuredContent: { id, ts, text },
        };
      }
    );

    registerListTool<NoteRow>(this.server, db, tenant, {
      name: "list_notes",
      description:
        "List notes, most recent first. Optionally filter by time window or a substring of the text.",
      table: "notes",
      resultKey: "notes",
      cols: ["text"],
      rowSchema: {
        id: z.number().int(),
        ts: z.string(),
        text: z.string(),
      },
      itemNoun: "notes",
      emptyText: "No notes recorded in that range.",
      line: (r) => `#${r.id}  ${r.ts}  ${r.text}`,
      extra: {
        key: "search",
        schema: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Substring to search for inside the note text (case-insensitive)"
          ),
        apply: (search, clauses, params) => {
          clauses.push("LOWER(text) LIKE ? ESCAPE '\\'");
          params.push(`%${escapeLike(search.toLowerCase())}%`);
        },
      },
    });

    registerDeleteTool(this.server, db, tenant, {
      name: "delete_note",
      description: "Delete a note by its numeric id.",
      table: "notes",
      label: "note",
      idDesc: "Note id to delete (from list_notes)",
    });

    registerMeasurementRecordTool(this.server, db, tenant, {
      name: "record_weight",
      description:
        "Record a baby weight measurement in whole grams. If the user does not specify a time, OMIT the `when` parameter — the server uses the current time.",
      table: "weights",
      field: "weight_g",
      unit: "g",
      label: "weight",
      valueDesc:
        "Weight in whole grams, e.g. 4250. If the user gives kilograms, pounds, or decimals, convert and round first (1 kg = 1000 g).",
    });

    registerListTool<WeightRow>(this.server, db, tenant, {
      name: "list_weights",
      description:
        "List weight measurements, most recent first. Optionally filter by time window.",
      table: "weights",
      resultKey: "weights",
      cols: ["weight_g"],
      rowSchema: {
        id: z.number().int(),
        ts: z.string(),
        weight_g: z.number().int(),
      },
      itemNoun: "measurements",
      emptyText: "No weight measurements in that range.",
      line: (r) => `#${r.id}  ${r.ts}  ${r.weight_g} g`,
    });

    registerDeleteTool(this.server, db, tenant, {
      name: "delete_weight",
      description: "Delete a weight measurement by its numeric id.",
      table: "weights",
      label: "weight",
      idDesc: "Weight id to delete (from list_weights)",
    });

    registerMeasurementRecordTool(this.server, db, tenant, {
      name: "record_height",
      description:
        "Record a baby length/height measurement in whole centimeters (babies are measured lying down, so this is technically length). If the user does not specify a time, OMIT the `when` parameter — the server uses the current time.",
      table: "heights",
      field: "height_cm",
      unit: "cm",
      label: "height",
      valueDesc:
        "Length/height in whole centimeters, e.g. 54. If given in inches, meters, or with decimals, convert and round first.",
    });

    registerListTool<HeightRow>(this.server, db, tenant, {
      name: "list_heights",
      description:
        "List height/length measurements, most recent first. Optionally filter by time window.",
      table: "heights",
      resultKey: "heights",
      cols: ["height_cm"],
      rowSchema: {
        id: z.number().int(),
        ts: z.string(),
        height_cm: z.number().int(),
      },
      itemNoun: "measurements",
      emptyText: "No height measurements in that range.",
      line: (r) => `#${r.id}  ${r.ts}  ${r.height_cm} cm`,
    });

    registerDeleteTool(this.server, db, tenant, {
      name: "delete_height",
      description: "Delete a height measurement by its numeric id.",
      table: "heights",
      label: "height",
      idDesc: "Height id to delete (from list_heights)",
    });

    this.server.registerTool(
      "add_indication",
      {
        description:
          "Define a target the baby's care should follow over a window of N days. Examples:\n  '1 poop a day' → metric='diaper_count', filter='poop', target=1\n  '500 ml of milk a day' → metric='feeding_total_ml', target=500\n  'Vitamin D once a day' → metric='routine_count', filter='vitamin d', target=1\n  'bath every 2 days' → metric='routine_count', filter='bath', target=1, period_days=2\n  'max 4h between feedings' → metric='feeding_gap_max_min', target=240, comparison='<='.",
        inputSchema: {
          label: z
            .string()
            .min(1)
            .max(120)
            .describe(
              "Short human-readable label, e.g. '1 poop per day', 'bath every 2 days', 'max 4h between feedings'"
            ),
          metric: indicationMetricSchema.describe(
            "What to aggregate: feeding_total_ml (sum of feeding ml), feeding_count, feeding_gap_max_min (max minutes between consecutive feedings in the window, including the gap from the last feeding before the window and the trailing gap up to now / the end of the window — use with comparison='<='), diaper_count, routine_count, note_count"
          ),
          target: z
            .number()
            .nonnegative()
            .describe("Threshold value, e.g. 500 (ml), 1 (count), 240 (minutes)"),
          comparison: comparisonSchema
            .optional()
            .describe(
              "'>=' (minimum, default — at least this much in the window) or '<=' (maximum — no more than this in the window)"
            ),
          period_days: z
            .number()
            .int()
            .positive()
            .max(365)
            .optional()
            .describe(
              "Window length in days. Default 1 (per day). Use 2 for 'every 2 days', 7 for 'per week', etc."
            ),
          filter: z
            .string()
            .max(100)
            .optional()
            .describe(
              "Narrows the metric. diaper_count: 'pee' | 'poop' | 'both' (omit for any). routine_count: substring of routine name (e.g. 'vitamin d'). note_count: substring of note text. Not allowed for feeding_*."
            ),
          formula: formulaSchema
            .optional()
            .describe(
              "Make the target auto-progress with the baby's weight and age instead of staying fixed. When set, `target` becomes only a fallback (used when weight/age are unknown) and `metric` must match the formula: milk_ml_per_kg_day→feeding_total_ml, feeds_per_day→feeding_count, feed_gap_max_by_age→feeding_gap_max_min, poops_per_day_by_age→diaper_count."
            ),
          baby: babyField,
        },
        outputSchema: {
          id: z.number().int(),
          label: z.string(),
          metric: indicationMetricSchema,
          filter: z.string().nullable(),
          target: z.number(),
          comparison: comparisonSchema,
          period_days: z.number().int(),
          formula: z.string().nullable(),
        },
      },
      async ({
        label,
        metric,
        target,
        comparison,
        period_days,
        filter,
        formula,
        baby,
      }) => {
        if (metric === "diaper_count" && filter) {
          if (!["pee", "poop", "both"].includes(filter)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Invalid filter '${filter}' for diaper_count. Use 'pee', 'poop', 'both', or omit.`,
                },
              ],
              isError: true,
            };
          }
        }
        if (
          (metric === "feeding_total_ml" ||
            metric === "feeding_count" ||
            metric === "feeding_gap_max_min") &&
          filter
        ) {
          return {
            content: [
              {
                type: "text",
                text: `Filter is not supported for ${metric}. Omit it.`,
              },
            ],
            isError: true,
          };
        }
        if (formula && GROWTH_FORMULAS[formula].metric !== metric) {
          return {
            content: [
              {
                type: "text",
                text: `Formula '${formula}' requires metric='${GROWTH_FORMULAS[formula].metric}', not '${metric}'.`,
              },
            ],
            isError: true,
          };
        }

        // A growth formula fully determines its comparison and filter (it's a
        // max/min target on a specific slice), so derive them from the catalog
        // rather than trusting the caller. Otherwise e.g. a `feed_gap_max_by_age`
        // row added without `comparison` would store the default '>=' and the
        // evaluator (which uses the stored comparison) would silently invert the
        // "max feed gap" safety check.
        const effComparison = formula
          ? GROWTH_FORMULAS[formula].comparison
          : comparison ?? ">=";
        const effFilter = formula
          ? GROWTH_FORMULAS[formula].filter
          : filter ?? null;

        const t = await this.tenant();
        const targetBaby = pickBaby(t.babies, baby);

        const inserted = await db
          .prepare(
            `INSERT INTO indications (label, metric, filter, target, comparison, period_days, baby_id, formula, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING id`
          )
          .bind(
            label,
            metric,
            effFilter,
            target,
            effComparison,
            period_days ?? 1,
            targetBaby.id,
            formula ?? null,
            t.email
          )
          .first<{ id: number }>();

        const unit = indicationUnit(metric);
        const period = period_days ?? 1;
        const periodS = period === 1 ? "/d" : `/${period}d`;
        const id = inserted?.id ?? 0;
        const formulaS = formula ? ` (auto: ${formula})` : "";
        return {
          content: [
            {
              type: "text",
              text: `Added indication #${id}: ${label}  [${metric}${
                effFilter ? `:${effFilter}` : ""
              } ${effComparison} ${target}${unit ? " " + unit : ""}${periodS}]${formulaS}`,
            },
          ],
          structuredContent: {
            id,
            label,
            metric,
            filter: effFilter,
            target,
            comparison: effComparison,
            period_days: period,
            formula: formula ?? null,
          },
        };
      }
    );

    this.server.registerTool(
      "list_indications",
      {
        description:
          "List defined indications. By default only active ones; pass include_inactive=true to see all.",
        inputSchema: {
          include_inactive: z
            .boolean()
            .optional()
            .describe("Include indications where active=0. Default false."),
          baby: babyField,
        },
        outputSchema: {
          count: z.number().int(),
          indications: z.array(
            z.object({
              id: z.number().int(),
              label: z.string(),
              metric: indicationMetricSchema,
              filter: z.string().nullable(),
              target: z.number(),
              comparison: comparisonSchema,
              period_days: z.number().int(),
              active: z.boolean(),
              formula: z.string().nullable(),
            })
          ),
        },
      },
      async ({ include_inactive, baby }) => {
        const t = await this.tenant();
        const targetBaby = pickBaby(t.babies, baby);
        const where = include_inactive
          ? "WHERE baby_id = ?"
          : "WHERE active = 1 AND baby_id = ?";
        const { results } = await db
          .prepare(
            `SELECT id, label, metric, filter, target, comparison, period_days, active, formula
             FROM indications ${where}
             ORDER BY active DESC, id`
          )
          .bind(targetBaby.id)
          .all<IndicationRow>();

        const structured = results.map((r) => ({
          id: r.id,
          label: r.label,
          metric: r.metric,
          filter: r.filter,
          target: r.target,
          comparison: r.comparison,
          period_days: r.period_days,
          active: r.active === 1,
          formula: r.formula,
        }));

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: include_inactive
                  ? "No indications defined."
                  : "No active indications. Use add_indication to create one.",
              },
            ],
            structuredContent: { count: 0, indications: [] },
          };
        }

        const lines = results.map((r) => {
          const unit = indicationUnit(r.metric);
          const periodS = r.period_days === 1 ? "/d" : `/${r.period_days}d`;
          const auto = r.formula ? `  (auto: ${r.formula})` : "";
          return `#${r.id}  ${r.active ? " " : "[off]"} ${r.label}  →  ${r.metric}${
            r.filter ? `:${r.filter}` : ""
          } ${r.comparison} ${r.target}${unit ? " " + unit : ""}${periodS}${auto}`;
        });
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: { count: results.length, indications: structured },
        };
      }
    );

    registerDeleteTool(this.server, db, tenant, {
      name: "delete_indication",
      description: "Delete an indication by its numeric id.",
      table: "indications",
      label: "indication",
      idDesc: "Indication id (from list_indications)",
    });

    this.server.registerTool(
      "check_indications",
      {
        description:
          "Evaluate all active indications against a day's actuals. Reports which are met ([OK]) and which are missed ([MISS]). Days are Europe/Madrid calendar days (the household timezone); defaults to today.",
        inputSchema: {
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe(
              "ISO date YYYY-MM-DD (Europe/Madrid calendar day) to evaluate. Defaults to today."
            ),
          baby: babyField,
        },
        outputSchema: {
          date: z.string(),
          met_count: z.number().int(),
          total: z.number().int(),
          results: z.array(
            z.object({
              id: z.number().int(),
              label: z.string(),
              metric: indicationMetricSchema,
              filter: z.string().nullable(),
              target: z.number(),
              comparison: comparisonSchema,
              period_days: z.number().int(),
              actual: z.number(),
              unit: z.string(),
              met: z.boolean(),
              formula: z.string().nullable(),
            })
          ),
        },
      },
      async ({ date, baby }) => {
        const t = await this.tenant();
        const targetBaby = pickBaby(t.babies, baby);
        const now = new Date();
        const nowIso = now.toISOString();
        const day = date ?? madridDateOf(now);
        const dayStart = madridMidnightUtc(day);
        const { end } = madridDayWindow(day);
        // Gap metrics measure up to the end of the day for past days, or up
        // to now while the day is still running.
        const gapBoundary = end < nowIso ? end : nowIso;

        const [indicationsRes, weightsRes] = await db.batch([
          db
            .prepare(
              `SELECT id, label, metric, filter, target, comparison, period_days, active, formula
               FROM indications WHERE active = 1 AND baby_id = ? ORDER BY id`
            )
            .bind(targetBaby.id),
          db
            .prepare(
              // `ts < end` so evaluating a past day estimates its weight from
              // the weigh-ins known by then, not from a later (heavier) one —
              // which would overstate the milk-per-kg target for that day. For
              // today, `end` is in the future so this includes every weigh-in.
              "SELECT ts, weight_g FROM weights WHERE baby_id = ? AND ts < ? ORDER BY ts DESC LIMIT 2"
            )
            .bind(targetBaby.id, end),
        ]);
        const indications = indicationsRes.results as unknown as IndicationRow[];
        // Age is the calendar-day count for the evaluated civil date, so anchor
        // it at that date's UTC midnight — NOT `dayStart` (Madrid civil midnight,
        // which is 22:00/23:00Z the previous UTC day and reads one day short for
        // the whole civil day, e.g. "not yet born" on the birth day and target
        // step-downs firing a day late). Weight still projects to `dayStart`.
        const ageAt = new Date(`${day}T00:00:00Z`);
        // Growth-formula targets are computed as of the evaluated day.
        const growthCtx = {
          estWeightG: estimateWeightG(
            weightsRes.results as unknown as WeightSample[],
            dayStart,
            targetBaby.date_of_birth
          ),
          ageDays: ageDaysAt(targetBaby.date_of_birth, ageAt),
        };

        if (indications.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  "No active indications. Use add_indication to define one (e.g. '1 poop a day').",
              },
            ],
            structuredContent: {
              date: day,
              met_count: 0,
              total: 0,
              results: [],
            },
          };
        }

        const ageS = targetBaby.date_of_birth
          ? `, ${computeAge(targetBaby.date_of_birth, ageAt)}`
          : "";

        const actualResults = await db.batch(
          indications.map((ind) =>
            buildIndicationStatement(
              db,
              ind.metric,
              ind.filter,
              madridDayWindow(day, ind.period_days).start,
              end,
              targetBaby.id
            )
          )
        );

        const lines: string[] = [
          `Indications evaluated as of ${day} (Europe/Madrid${ageS}):`,
        ];
        const structured: Array<{
          id: number;
          label: string;
          metric: string;
          filter: string | null;
          target: number;
          comparison: ">=" | "<=";
          period_days: number;
          actual: number;
          unit: string;
          met: boolean;
          formula: string | null;
        }> = [];
        let met = 0;
        for (let i = 0; i < indications.length; i++) {
          const ind = indications[i];
          // Growth-formula rows resolve to a live target; static rows keep theirs.
          const target = resolveIndicationTarget(ind, growthCtx);
          const actual = extractIndicationActual(
            ind.metric,
            actualResults[i],
            gapBoundary,
            madridDayWindow(day, ind.period_days).start
          );
          const ok =
            ind.comparison === ">=" ? actual >= target : actual <= target;
          if (ok) met++;
          const unit = indicationUnit(ind.metric);
          const unitS = unit ? ` ${unit}` : "";
          const window =
            ind.period_days === 1 ? "/day" : ` over last ${ind.period_days} days`;
          const auto = ind.formula ? " auto" : "";
          lines.push(
            `${ok ? "[OK]  " : "[MISS]"} ${ind.label}  →  ${actual}${unitS} (target ${ind.comparison} ${target}${unitS}${auto}${window})`
          );
          structured.push({
            id: ind.id,
            label: ind.label,
            metric: ind.metric,
            filter: ind.filter,
            target,
            comparison: ind.comparison,
            period_days: ind.period_days,
            actual,
            unit,
            met: ok,
            formula: ind.formula,
          });
        }
        lines.push("");
        lines.push(`Met ${met}/${indications.length}.`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: {
            date: day,
            met_count: met,
            total: indications.length,
            results: structured,
          },
        };
      }
    );

    this.server.registerTool(
      "get_stats",
      {
        description:
          "Summarize feedings, diapers, routines, and notes within a time window, plus the latest weight (g) and height (cm). Pass `window` for a quick preset, or `since`/`until` for a custom range. Defaults to the last 24 hours.",
        inputSchema: {
          window: z
            .enum(["24h", "today", "7d", "30d"])
            .optional()
            .describe(
              "Quick preset. '24h' = last 24 hours; 'today' = since midnight Europe/Madrid (the household timezone); '7d' = last 7×24h; '30d' = last 30×24h. If set, ignores `since`/`until`."
            ),
          since: z
            .string()
            .datetime({ offset: true })
            .optional()
            .describe("Start of the window (ISO timestamp). Default: 24h ago."),
          until: z
            .string()
            .datetime({ offset: true })
            .optional()
            .describe("End of the window (ISO timestamp). Default: now."),
          baby: babyField,
        },
        outputSchema: {
          start: z.string(),
          end: z.string(),
          feedings: z.object({
            count: z.number().int(),
            total_ml: z.number(),
            avg_ml: z.number(),
            last_ts: z.string().nullable(),
          }),
          diapers: z.object({
            count: z.number().int(),
            pee_count: z.number().int(),
            poop_count: z.number().int(),
            last_ts: z.string().nullable(),
          }),
          routines: z.object({
            count: z.number().int(),
            last_ts: z.string().nullable(),
            by_name: z.array(
              z.object({ name: z.string(), count: z.number().int() })
            ),
          }),
          notes: z.object({
            count: z.number().int(),
            last_ts: z.string().nullable(),
          }),
          latest_weight: z
            .object({ ts: z.string(), weight_g: z.number().int() })
            .nullable(),
          latest_height: z
            .object({ ts: z.string(), height_cm: z.number().int() })
            .nullable(),
        },
      },
      async ({ window, since, until, baby }) => {
        const t = await this.tenant();
        const targetBaby = pickBaby(t.babies, baby);
        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        let start: string;
        let end: string;
        if (window === "today") {
          start = madridMidnightUtc(madridDateOf(new Date(now))).toISOString();
          end = nowIso;
        } else if (window) {
          start = new Date(now - WINDOW_OFFSET_MS[window]).toISOString();
          end = nowIso;
        } else {
          end = until ? normalizeTs(until) : nowIso;
          start = since ? normalizeTs(since) : new Date(now - DAY_MS).toISOString();
        }

        const [
          feedAgg,
          diaperAgg,
          routineAgg,
          routineBreakdown,
          noteAgg,
          weightLatest,
          heightLatest,
        ] = await db.batch([
          db.prepare(
            `SELECT
               COUNT(*)                    AS count,
               COALESCE(SUM(amount_ml), 0) AS total_ml,
               COALESCE(AVG(amount_ml), 0) AS avg_ml,
               MAX(ts)                     AS last_ts
             FROM feedings
             WHERE baby_id = ? AND ts >= ? AND ts < ?`
          ).bind(targetBaby.id, start, end),
          db.prepare(
            `SELECT
               COUNT(*)                                                   AS event_count,
               SUM(CASE WHEN kind IN ('pee',  'both') THEN 1 ELSE 0 END)  AS pee_count,
               SUM(CASE WHEN kind IN ('poop', 'both') THEN 1 ELSE 0 END)  AS poop_count,
               MAX(ts)                                                    AS last_ts
             FROM diapers
             WHERE baby_id = ? AND ts >= ? AND ts < ?`
          ).bind(targetBaby.id, start, end),
          db.prepare(
            `SELECT COUNT(*) AS count, MAX(ts) AS last_ts
             FROM routines
             WHERE baby_id = ? AND ts >= ? AND ts < ?`
          ).bind(targetBaby.id, start, end),
          db.prepare(
            `SELECT name, COUNT(*) AS n
             FROM routines
             WHERE baby_id = ? AND ts >= ? AND ts < ?
             GROUP BY name
             ORDER BY n DESC`
          ).bind(targetBaby.id, start, end),
          db.prepare(
            `SELECT COUNT(*) AS count, MAX(ts) AS last_ts
             FROM notes
             WHERE baby_id = ? AND ts >= ? AND ts < ?`
          ).bind(targetBaby.id, start, end),
          db.prepare(
            "SELECT ts, weight_g FROM weights WHERE baby_id = ? ORDER BY ts DESC LIMIT 1"
          ).bind(targetBaby.id),
          db.prepare(
            "SELECT ts, height_cm FROM heights WHERE baby_id = ? ORDER BY ts DESC LIMIT 1"
          ).bind(targetBaby.id),
        ]);

        const feed = feedAgg.results[0] as {
          count: number;
          total_ml: number;
          avg_ml: number;
          last_ts: string | null;
        };
        const diaper = diaperAgg.results[0] as {
          event_count: number;
          pee_count: number;
          poop_count: number;
          last_ts: string | null;
        };
        const routines = routineAgg.results[0] as {
          count: number;
          last_ts: string | null;
        };
        const routinesByName = routineBreakdown.results as Array<{
          name: string;
          n: number;
        }>;
        const notes = noteAgg.results[0] as {
          count: number;
          last_ts: string | null;
        };

        const latestWeight = (
          weightLatest.results as Array<{ ts: string; weight_g: number }>
        )[0];
        const latestHeight = (
          heightLatest.results as Array<{ ts: string; height_cm: number }>
        )[0];

        const lines: string[] = [];
        if (targetBaby.name || targetBaby.sex || targetBaby.date_of_birth) {
          const bits: string[] = [];
          if (targetBaby.name) bits.push(targetBaby.name);
          if (targetBaby.sex) bits.push(targetBaby.sex);
          if (targetBaby.date_of_birth)
            bits.push(computeAge(targetBaby.date_of_birth));
          lines.push(`Baby: ${bits.join(", ")}`);
          lines.push("");
        }
        lines.push(`Window:   ${start}  →  ${end}`, "");

        if (feed.count === 0) {
          lines.push("Feedings:    none");
        } else {
          lines.push(
            `Feedings:    ${feed.count}  (total ${feed.total_ml} ml, avg ${feed.avg_ml.toFixed(
              1
            )} ml, last ${feed.last_ts})`
          );
        }

        if (diaper.event_count === 0) {
          lines.push("Diapers:     none");
        } else {
          lines.push(
            `Diapers:     ${diaper.event_count}  (pee ${diaper.pee_count}, poop ${diaper.poop_count}, last ${diaper.last_ts})`
          );
        }

        if (routines.count === 0) {
          lines.push("Routines:    none");
        } else {
          const breakdown = routinesByName
            .map((m) => `${m.name}×${m.n}`)
            .join(", ");
          lines.push(
            `Routines:    ${routines.count}  (${breakdown}, last ${routines.last_ts})`
          );
        }

        if (notes.count === 0) {
          lines.push("Notes:       none");
        } else {
          lines.push(`Notes:       ${notes.count}  (last ${notes.last_ts})`);
        }

        if (latestWeight || latestHeight) {
          lines.push("");
        }
        if (latestWeight) {
          lines.push(
            `Latest weight: ${latestWeight.weight_g} g  (measured ${latestWeight.ts})`
          );
        }
        if (latestHeight) {
          lines.push(
            `Latest height: ${latestHeight.height_cm} cm  (measured ${latestHeight.ts})`
          );
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: {
            start,
            end,
            feedings: {
              count: feed.count,
              total_ml: feed.total_ml,
              avg_ml: feed.avg_ml,
              last_ts: feed.last_ts,
            },
            diapers: {
              count: diaper.event_count,
              pee_count: diaper.pee_count,
              poop_count: diaper.poop_count,
              last_ts: diaper.last_ts,
            },
            routines: {
              count: routines.count,
              last_ts: routines.last_ts,
              by_name: routinesByName.map((r) => ({
                name: r.name,
                count: r.n,
              })),
            },
            notes: {
              count: notes.count,
              last_ts: notes.last_ts,
            },
            latest_weight: latestWeight
              ? { ts: latestWeight.ts, weight_g: latestWeight.weight_g }
              : null,
            latest_height: latestHeight
              ? { ts: latestHeight.ts, height_cm: latestHeight.height_cm }
              : null,
          },
        };
      }
    );

    // record_many uses a flat schema where `amount_ml`/`kind`/`name`/`text` are
    // all optional on every event; we then runtime-check the right field for
    // the chosen `type`. A Zod `discriminatedUnion` would be cleaner, but it
    // serializes to JSON Schema `oneOf` and not every MCP client today
    // dispatches that well — so we keep the shape flat and validate manually.
    this.server.registerTool(
      "record_many",
      {
        description:
          "Record several events at once when the user mentions multiple things in one breath (e.g. 'I gave her Vitamin D, bathed her and did tummy time'). Use this instead of multiple separate calls so the response stays tidy. Each event picks one `type` plus its own required fields. The call is all-or-nothing: if any event is invalid or any INSERT fails, nothing is recorded and the errors are returned.",
        inputSchema: {
          when: z
            .string()
            .datetime({ offset: true })
            .optional()
            .describe(
              "Default ISO 8601 timestamp (UTC or with offset) applied to events that omit their own `when`. Omit to use the current server time. Per-event `when` overrides this."
            ),
          events: z
            .array(
              z.object({
                type: z
                  .enum(["feeding", "diaper", "routine", "note"])
                  .describe("Event kind"),
                amount_ml: z
                  .number()
                  .positive()
                  .max(MAX_FEEDING_ML)
                  .optional()
                  .describe("Required for `feeding`: milk in ml"),
                kind: z
                  .enum(["pee", "poop", "both"])
                  .optional()
                  .describe("Required for `diaper`: pee | poop | both"),
                name: z
                  .string()
                  .min(1)
                  .max(100)
                  .optional()
                  .describe("Required for `routine`: entry name"),
                text: z
                  .string()
                  .min(1)
                  .max(2000)
                  .optional()
                  .describe("Required for `note`: free-form text"),
                when: z
                  .string()
                  .datetime({ offset: true })
                  .optional()
                  .describe(
                    "Per-event ISO 8601 timestamp (UTC or with offset); overrides the top-level `when`"
                  ),
              })
            )
            .min(1)
            .max(20)
            .describe("List of events to record (1-20)"),
          baby: babyField,
        },
        outputSchema: {
          count: z.number().int(),
          recorded: z.array(
            z.object({
              type: z.enum(["feeding", "diaper", "routine", "note"]),
              id: z.number().int(),
              ts: z.string(),
            })
          ),
          errors: z.array(z.string()),
        },
      },
      async ({ events, when: defaultWhen, baby }) => {
        const t = await this.tenant();
        const targetBaby = pickBaby(t.babies, baby);
        const defaultTs = normalizeTs(defaultWhen);
        type EvType = "feeding" | "diaper" | "routine" | "note";
        const stmts: D1PreparedStatement[] = [];
        const stmtMeta: Array<{ type: EvType; ts: string }> = [];
        const errors: string[] = [];

        for (let i = 0; i < events.length; i++) {
          const ev = events[i];
          const ts = ev.when ? normalizeTs(ev.when) : defaultTs;
          if (ev.type === "feeding") {
            if (ev.amount_ml === undefined) {
              errors.push(`event #${i}: feeding requires amount_ml`);
              continue;
            }
            stmts.push(
              db
                .prepare(
                  "INSERT INTO feedings (ts, amount_ml, baby_id, created_by) VALUES (?, ?, ?, ?) RETURNING id"
                )
                .bind(ts, ev.amount_ml, targetBaby.id, t.email)
            );
            stmtMeta.push({ type: "feeding", ts });
          } else if (ev.type === "diaper") {
            if (!ev.kind) {
              errors.push(`event #${i}: diaper requires kind`);
              continue;
            }
            stmts.push(
              db
                .prepare(
                  "INSERT INTO diapers (ts, kind, baby_id, created_by) VALUES (?, ?, ?, ?) RETURNING id"
                )
                .bind(ts, ev.kind, targetBaby.id, t.email)
            );
            stmtMeta.push({ type: "diaper", ts });
          } else if (ev.type === "routine") {
            if (!ev.name) {
              errors.push(`event #${i}: routine requires name`);
              continue;
            }
            stmts.push(
              db
                .prepare(
                  "INSERT INTO routines (ts, name, baby_id, created_by) VALUES (?, ?, ?, ?) RETURNING id"
                )
                .bind(ts, ev.name, targetBaby.id, t.email)
            );
            stmtMeta.push({ type: "routine", ts });
          } else if (ev.type === "note") {
            if (!ev.text) {
              errors.push(`event #${i}: note requires text`);
              continue;
            }
            stmts.push(
              db
                .prepare(
                  "INSERT INTO notes (ts, text, baby_id, created_by) VALUES (?, ?, ?, ?) RETURNING id"
                )
                .bind(ts, ev.text, targetBaby.id, t.email)
            );
            stmtMeta.push({ type: "note", ts });
          }
        }

        // All-or-nothing: if any event failed validation, record none of
        // them (matching the atomicity promised in the description).
        if (errors.length > 0) {
          const lines = ["No events recorded.", "", "Errors:"];
          for (const err of errors) lines.push(`  - ${err}`);
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            structuredContent: { count: 0, recorded: [], errors },
            isError: true,
          };
        }

        const recorded: Array<{ type: EvType; id: number; ts: string }> = [];
        try {
          const batchResults = await db.batch<{ id: number }>(stmts);
          for (let i = 0; i < batchResults.length; i++) {
            const m = stmtMeta[i];
            const id = batchResults[i].results[0]?.id ?? 0;
            recorded.push({ type: m.type, id, ts: m.ts });
          }
        } catch (e) {
          errors.push(
            `batch insert failed: ${e instanceof Error ? e.message : String(e)}`
          );
        }

        const lines: string[] = recorded.map(
          (r) => `Recorded ${r.type} #${r.id} at ${r.ts}.`
        );
        if (errors.length > 0) {
          lines.push("", "Errors:");
          for (const err of errors) lines.push(`  - ${err}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: {
            count: recorded.length,
            recorded,
            errors,
          },
          isError: recorded.length === 0 && errors.length > 0,
        };
      }
    );

    // ---- Household management ------------------------------------------------

    this.server.registerTool(
      "add_baby",
      {
        description:
          "Add a baby to the caller's household. The first baby in a household becomes the default; use set_default_baby to change it later. Other tools target a specific baby via their `baby` parameter.",
        inputSchema: {
          name: z.string().min(1).max(100).describe("Baby's name, e.g. 'Sofía'"),
          sex: z
            .enum(["male", "female"])
            .optional()
            .describe("Biological sex, if known"),
          date_of_birth: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe("ISO date YYYY-MM-DD"),
        },
        outputSchema: {
          id: z.number().int(),
          name: z.string(),
          is_default: z.boolean(),
        },
      },
      async ({ name, sex, date_of_birth }) => {
        const t = await this.tenant();
        const created = await addBaby(db, t.householdId, t.babies.length, {
          name,
          sex,
          date_of_birth,
        });
        return {
          content: [
            {
              type: "text",
              text: `Added baby '${name}' (#${created.id})${created.is_default ? " as the default baby" : ""}.`,
            },
          ],
          structuredContent: {
            id: created.id,
            name,
            is_default: created.is_default,
          },
        };
      }
    );

    this.server.registerTool(
      "set_default_baby",
      {
        description:
          "Make one of the household's babies the default — the one every tool targets when its `baby` parameter is omitted.",
        inputSchema: {
          baby: z
            .string()
            .min(1)
            .max(100)
            .describe("Baby name or numeric id (see get_profile)"),
        },
      },
      async ({ baby }) => {
        const t = await this.tenant();
        const target = pickBaby(t.babies, baby);
        await db.batch([
          db
            .prepare("UPDATE babies SET is_default = 0 WHERE household_id = ?")
            .bind(t.householdId),
          db
            .prepare("UPDATE babies SET is_default = 1 WHERE id = ?")
            .bind(target.id),
        ]);
        return {
          content: [
            {
              type: "text",
              text: `${target.name ?? `Baby #${target.id}`} is now the default baby.`,
            },
          ],
        };
      }
    );

    this.server.registerTool(
      "add_caregiver",
      {
        description:
          "Register another caregiver's email into the caller's household so they see and record the same data. The email must match what they use to log in through Cloudflare Access (they must also be allowed by the Access policy — that lives in Cloudflare, not here).",
        inputSchema: {
          email: z
            .string()
            .email()
            .describe("Email address of the caregiver to add"),
        },
      },
      async ({ email }) => {
        const t = await this.tenant();
        const norm = email.toLowerCase();
        const error = await addCaregiver(db, t.householdId, email);
        if (error) {
          return { content: [{ type: "text", text: error }], isError: true };
        }
        return {
          content: [
            {
              type: "text",
              text: `Added ${norm} to your household. Make sure the Cloudflare Access policy also allows this email, or they cannot reach the app.`,
            },
          ],
        };
      }
    );

    this.server.registerTool(
      "remove_caregiver",
      {
        description:
          "Remove a caregiver's email from the caller's household so they no longer see or record its data. You cannot remove yourself. This does not touch the Cloudflare Access policy (that lives in Cloudflare, not here).",
        inputSchema: {
          email: z
            .string()
            .email()
            .describe("Email address of the caregiver to remove"),
        },
      },
      async ({ email }) => {
        const t = await this.tenant();
        const norm = email.toLowerCase();
        const target = await db
          .prepare(
            "SELECT id, email, household_id FROM users WHERE email = ? AND household_id = ?"
          )
          .bind(norm, t.householdId)
          .first<UserRow>();
        if (!target) {
          return {
            content: [
              {
                type: "text",
                text: `${norm} is not a caregiver in your household.`,
              },
            ],
            isError: true,
          };
        }
        const res = await removeCaregiver(db, t, target.id);
        if (!res.ok) {
          return {
            content: [{ type: "text", text: res.message }],
            isError: true,
          };
        }
        return {
          content: [
            { type: "text", text: `Removed ${norm} from your household.` },
          ],
        };
      }
    );

    this.server.registerTool(
      "create_household",
      {
        description:
          "Create a NEW isolated household (tenant) with its first caregiver and an unnamed default baby. The new household's data is completely separate from yours. The caregiver must also be allowed by the Cloudflare Access policy (managed in Cloudflare, not here).",
        inputSchema: {
          email: z
            .string()
            .email()
            .describe("Email of the new household's first caregiver"),
          name: z
            .string()
            .min(1)
            .max(100)
            .optional()
            .describe("Optional household name"),
        },
        outputSchema: {
          household_id: z.number().int(),
          email: z.string(),
        },
      },
      async ({ email, name }) => {
        await this.tenant(); // any registered user may onboard a new tenant
        const norm = email.toLowerCase();
        const existing = await db
          .prepare("SELECT id FROM users WHERE email = ?")
          .bind(norm)
          .first<{ id: number }>();
        if (existing) {
          return {
            content: [
              {
                type: "text",
                text: `${norm} is already registered — emails belong to exactly one household.`,
              },
            ],
            isError: true,
          };
        }
        // One atomic batch: households → users → babies. D1 runs a batch in a
        // single transaction, so if any step fails the whole thing rolls back —
        // a failed user/baby insert can't leave an orphan household behind (the
        // old two-step version could). `last_insert_rowid()` is the new
        // household's id right after its insert; the baby resolves it via the
        // just-inserted (and, per the check above, unique) caregiver email.
        const res = await db.batch([
          db.prepare("INSERT INTO households (name) VALUES (?)").bind(name ?? null),
          db
            .prepare(
              "INSERT INTO users (email, household_id) VALUES (?, last_insert_rowid())"
            )
            .bind(norm),
          db
            .prepare(
              "INSERT INTO babies (household_id, is_default) VALUES ((SELECT household_id FROM users WHERE email = ?), 1)"
            )
            .bind(norm),
          db
            .prepare("SELECT household_id AS id FROM users WHERE email = ?")
            .bind(norm),
        ]);
        const householdId =
          (res[3].results as Array<{ id: number }>)[0]?.id ?? 0;
        return {
          content: [
            {
              type: "text",
              text: `Created household #${householdId} with ${norm} as its first caregiver and an unnamed default baby (they can set_profile it). Remember to allow ${norm} in the Cloudflare Access policy.`,
            },
          ],
          structuredContent: { household_id: householdId, email: norm },
        };
      }
    );
  }
}
