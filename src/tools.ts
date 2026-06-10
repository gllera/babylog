// -----------------------------------------------------------------------------
// The MCP agent: a Durable Object exposing all baby-diary tools over /mcp.
// -----------------------------------------------------------------------------

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  Env,
  DiaperKind,
  FeedingRow,
  DiaperRow,
  RoutineRow,
  NoteRow,
  WeightRow,
  HeightRow,
  ProfileRow,
} from "./types";
import {
  DAY_MS,
  computeAge,
  normalizeTs,
  formatGap,
  maxGapMinutes,
  buildWindowClauses,
  madridDateOf,
  madridMidnightUtc,
  madridDayWindow,
  insertAndLookupPrev,
} from "./lib";
import { SERVER_ORIGIN } from "./web";

function formatProfile(row: ProfileRow | null): string {
  if (!row) return "No profile set.";
  const lines = [
    `Name: ${row.name ?? "—"}`,
    `Sex:  ${row.sex ?? "—"}`,
  ];
  if (row.date_of_birth) {
    lines.push(`DOB:  ${row.date_of_birth}  (${computeAge(row.date_of_birth)})`);
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

async function deleteById(
  db: D1Database,
  table: string,
  label: string,
  id: number
) {
  const res = await db
    .prepare(`DELETE FROM ${table} WHERE id = ?`)
    .bind(id)
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

type IndicationRow = {
  id: number;
  label: string;
  metric: IndicationMetric;
  filter: string | null;
  target: number;
  comparison: ">=" | "<=";
  period_days: number;
  active: number;
};

function buildIndicationStatement(
  db: D1Database,
  metric: IndicationMetric,
  filter: string | null,
  start: string,
  end: string
): D1PreparedStatement {
  switch (metric) {
    case "feeding_total_ml":
      return db
        .prepare(
          "SELECT COALESCE(SUM(amount_ml), 0) AS v FROM feedings WHERE ts >= ? AND ts < ?"
        )
        .bind(start, end);
    case "feeding_count":
      return db
        .prepare("SELECT COUNT(*) AS v FROM feedings WHERE ts >= ? AND ts < ?")
        .bind(start, end);
    case "feeding_gap_max_min":
      // Also fetch the last feeding *before* the window so the gap across
      // the window start is measured (see maxGapMinutes).
      return db
        .prepare(
          `SELECT ts FROM (SELECT ts FROM feedings WHERE ts < ? ORDER BY ts DESC LIMIT 1)
           UNION ALL
           SELECT ts FROM feedings WHERE ts >= ? AND ts < ? ORDER BY ts`
        )
        .bind(start, start, end);
    case "diaper_count": {
      let sql = "SELECT COUNT(*) AS v FROM diapers WHERE ts >= ? AND ts < ?";
      if (filter === "pee") sql += " AND kind IN ('pee','both')";
      else if (filter === "poop") sql += " AND kind IN ('poop','both')";
      else if (filter === "both") sql += " AND kind = 'both'";
      return db.prepare(sql).bind(start, end);
    }
    case "routine_count":
      if (filter) {
        return db
          .prepare(
            "SELECT COUNT(*) AS v FROM routines WHERE ts >= ? AND ts < ? AND LOWER(name) LIKE ?"
          )
          .bind(start, end, `%${filter.toLowerCase()}%`);
      }
      return db
        .prepare("SELECT COUNT(*) AS v FROM routines WHERE ts >= ? AND ts < ?")
        .bind(start, end);
    case "note_count":
      return db
        .prepare("SELECT COUNT(*) AS v FROM notes WHERE ts >= ? AND ts < ?")
        .bind(start, end);
  }
}

// `gapBoundary` is min(window end, now): gap metrics measure the trailing gap
// from the last feeding up to that instant.
function extractIndicationActual(
  metric: IndicationMetric,
  result: D1Result<unknown>,
  gapBoundary: string
): number {
  if (metric === "feeding_gap_max_min") {
    const rows = result.results as Array<{ ts: string }>;
    return maxGapMinutes(
      rows.map((r) => r.ts),
      gapBoundary
    );
  }
  const rows = result.results as Array<{ v: number }>;
  return rows[0]?.v ?? 0;
}

function indicationUnit(metric: IndicationMetric): string {
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
      const { clauses, params } = buildWindowClauses(
        args.since as string | undefined,
        args.until as string | undefined
      );
      if (spec.extra) {
        const v = args[spec.extra.key];
        if (typeof v === "string" && v) spec.extra.apply(v, clauses, params);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
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
    async ({ id }) => deleteById(db, spec.table, spec.label, id)
  );
}

// record_weight / record_height are identical apart from field, unit, and text.
function registerMeasurementRecordTool(
  server: McpServer,
  db: D1Database,
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
      const value = args[spec.field] as number;
      const ts = normalizeTs(args.when as string | undefined);
      const { id, prev } = await insertAndLookupPrev<
        { ts: string } & Record<string, number | string>
      >(
        db,
        db
          .prepare(
            `SELECT ts, ${spec.field} FROM ${spec.table} WHERE ts < ? ORDER BY ts DESC LIMIT 1`
          )
          .bind(ts),
        db
          .prepare(
            `INSERT INTO ${spec.table} (ts, ${spec.field}) VALUES (?, ?) RETURNING id`
          )
          .bind(ts, value)
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
            text: `Recorded ${spec.label} #${id}: ${value} ${spec.unit} at ${ts}${delta}.`,
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

export class BabyFeedingMCP extends McpAgent<Env> {
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

  async init() {
    const db = this.env.DB;

    this.server.registerTool(
      "set_profile",
      {
        description:
          "Set the baby's profile fields (name, sex, date of birth). Pass only the fields you want to update — others stay as they were. At least one field is required.",
        inputSchema: {
          name: z
            .string()
            .min(1)
            .max(100)
            .optional()
            .describe("Baby's name, e.g. 'Sofía'"),
          sex: z
            .enum(["male", "female", "other"])
            .optional()
            .describe(
              "Biological sex: 'male', 'female', or 'other'. (Spanish 'niño'/'masculino' → 'male', 'niña'/'femenino' → 'female')"
            ),
          date_of_birth: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe(
              "Date of birth in ISO date format YYYY-MM-DD, e.g. '2026-04-01'"
            ),
        },
      },
      async ({ name, sex, date_of_birth }) => {
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
          .prepare(`UPDATE profile SET ${updates.join(", ")} WHERE id = 1`)
          .bind(...params)
          .run();

        const row = await db
          .prepare("SELECT name, sex, date_of_birth FROM profile WHERE id = 1")
          .first<ProfileRow>();

        return {
          content: [
            {
              type: "text",
              text: `Profile updated.\n${formatProfile(row)}`,
            },
          ],
        };
      }
    );

    this.server.registerTool(
      "get_profile",
      {
        description:
          "Get the baby's profile: name, sex, date of birth, and computed age.",
        outputSchema: {
          name: z.string().nullable(),
          sex: z.enum(["male", "female", "other"]).nullable(),
          date_of_birth: z.string().nullable(),
          age: z.string().nullable(),
          age_days: z.number().int().nullable(),
        },
      },
      async () => {
        const row = await db
          .prepare("SELECT name, sex, date_of_birth FROM profile WHERE id = 1")
          .first<ProfileRow>();
        let age: string | null = null;
        let ageDays: number | null = null;
        if (row?.date_of_birth) {
          age = computeAge(row.date_of_birth);
          const birth = new Date(`${row.date_of_birth}T00:00:00Z`);
          ageDays = Math.floor((Date.now() - birth.getTime()) / DAY_MS);
        }
        return {
          content: [{ type: "text", text: formatProfile(row) }],
          structuredContent: {
            name: row?.name ?? null,
            sex: row?.sex ?? null,
            date_of_birth: row?.date_of_birth ?? null,
            age,
            age_days: ageDays,
          },
        };
      }
    );

    this.server.registerTool(
      "record_feeding",
      {
        description:
          "Record a milk feeding for the baby. If the user does not specify a time, OMIT the `when` parameter — the server records the feeding at the current time. Only pass `when` if the user gave an explicit past/future time. The response includes the gap since the previous feeding so the agent can mention it.",
        inputSchema: {
          amount_ml: z
            .number()
            .positive()
            .describe("Amount of milk in milliliters, e.g. 120"),
          when: whenInput(
            "Optional ISO 8601 timestamp (e.g. 2026-05-14T07:30:00Z, or with a local offset like 2026-05-14T09:30:00+02:00 — stored as UTC). OMIT this when the feeding is happening now — the server fills in the current time. Only pass this if the user explicitly gave a different time."
          ),
        },
        outputSchema: {
          id: z.number().int(),
          ts: z.string(),
          amount_ml: z.number(),
          gap_since_previous: z.string().nullable(),
          gap_since_previous_min: z.number().int().nullable(),
          previous_ts: z.string().nullable(),
        },
      },
      async ({ amount_ml, when }) => {
        const ts = normalizeTs(when);
        const { id, prev } = await insertAndLookupPrev<{ ts: string }>(
          db,
          db
            .prepare(
              "SELECT ts FROM feedings WHERE ts < ? ORDER BY ts DESC LIMIT 1"
            )
            .bind(ts),
          db
            .prepare(
              "INSERT INTO feedings (ts, amount_ml) VALUES (?, ?) RETURNING id"
            )
            .bind(ts, amount_ml)
        );
        const { gapStr, gapMin, gapNote } = formatGap(ts, prev?.ts ?? null);

        return {
          content: [
            {
              type: "text",
              text: `Recorded feeding #${id}: ${amount_ml} ml at ${ts}${gapNote}.`,
            },
          ],
          structuredContent: {
            id,
            ts,
            amount_ml,
            gap_since_previous: gapStr,
            gap_since_previous_min: gapMin,
            previous_ts: prev?.ts ?? null,
          },
        };
      }
    );

    registerListTool<FeedingRow>(this.server, db, {
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

    registerDeleteTool(this.server, db, {
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
      async ({ kind, when }) => {
        const ts = normalizeTs(when);
        const { id, prev } = await insertAndLookupPrev<{
          ts: string;
          kind: DiaperKind;
        }>(
          db,
          db
            .prepare(
              "SELECT ts, kind FROM diapers WHERE ts < ? ORDER BY ts DESC LIMIT 1"
            )
            .bind(ts),
          db
            .prepare(
              "INSERT INTO diapers (ts, kind) VALUES (?, ?) RETURNING id"
            )
            .bind(ts, kind)
        );
        const { gapStr, gapMin, gapNote } = formatGap(ts, prev?.ts ?? null);

        return {
          content: [
            {
              type: "text",
              text: `Recorded diaper #${id}: ${kind} at ${ts}${gapNote}.`,
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

    registerListTool<DiaperRow>(this.server, db, {
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

    registerDeleteTool(this.server, db, {
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
      async ({ name, when }) => {
        const ts = normalizeTs(when);
        const { id, prev } = await insertAndLookupPrev<{ ts: string }>(
          db,
          db
            .prepare(
              "SELECT ts FROM routines WHERE ts < ? AND LOWER(name) = LOWER(?) ORDER BY ts DESC LIMIT 1"
            )
            .bind(ts, name),
          db
            .prepare(
              "INSERT INTO routines (ts, name) VALUES (?, ?) RETURNING id"
            )
            .bind(ts, name)
        );
        const { gapStr, gapMin, gapNote } = formatGap(ts, prev?.ts ?? null, name);

        return {
          content: [
            {
              type: "text",
              text: `Recorded routine #${id}: ${name} at ${ts}${gapNote}.`,
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

    registerListTool<RoutineRow>(this.server, db, {
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
          clauses.push("LOWER(name) LIKE ?");
          params.push(`%${name.toLowerCase()}%`);
        },
      },
    });

    registerDeleteTool(this.server, db, {
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
        },
        outputSchema: {
          id: z.number().int(),
          ts: z.string(),
          text: z.string(),
        },
      },
      async ({ text, when }) => {
        const ts = normalizeTs(when);
        const inserted = await db
          .prepare("INSERT INTO notes (ts, text) VALUES (?, ?) RETURNING id")
          .bind(ts, text)
          .first<{ id: number }>();

        const id = inserted?.id ?? 0;
        return {
          content: [
            {
              type: "text",
              text: `Recorded note #${id} at ${ts}: ${text}`,
            },
          ],
          structuredContent: { id, ts, text },
        };
      }
    );

    registerListTool<NoteRow>(this.server, db, {
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
          clauses.push("LOWER(text) LIKE ?");
          params.push(`%${search.toLowerCase()}%`);
        },
      },
    });

    registerDeleteTool(this.server, db, {
      name: "delete_note",
      description: "Delete a note by its numeric id.",
      table: "notes",
      label: "note",
      idDesc: "Note id to delete (from list_notes)",
    });

    registerMeasurementRecordTool(this.server, db, {
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

    registerListTool<WeightRow>(this.server, db, {
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

    registerDeleteTool(this.server, db, {
      name: "delete_weight",
      description: "Delete a weight measurement by its numeric id.",
      table: "weights",
      label: "weight",
      idDesc: "Weight id to delete (from list_weights)",
    });

    registerMeasurementRecordTool(this.server, db, {
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

    registerListTool<HeightRow>(this.server, db, {
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

    registerDeleteTool(this.server, db, {
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
              "Narrows the metric. diaper_count: 'pee' | 'poop' | 'both' (omit for any). routine_count: substring of routine name (e.g. 'vitamin d'). Not allowed for feeding_* or note_count."
            ),
        },
        outputSchema: {
          id: z.number().int(),
          label: z.string(),
          metric: indicationMetricSchema,
          filter: z.string().nullable(),
          target: z.number(),
          comparison: comparisonSchema,
          period_days: z.number().int(),
        },
      },
      async ({
        label,
        metric,
        target,
        comparison,
        period_days,
        filter,
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
            metric === "feeding_gap_max_min" ||
            metric === "note_count") &&
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

        const inserted = await db
          .prepare(
            `INSERT INTO indications (label, metric, filter, target, comparison, period_days)
             VALUES (?, ?, ?, ?, ?, ?)
             RETURNING id`
          )
          .bind(
            label,
            metric,
            filter ?? null,
            target,
            comparison ?? ">=",
            period_days ?? 1
          )
          .first<{ id: number }>();

        const unit = indicationUnit(metric);
        const period = period_days ?? 1;
        const periodS = period === 1 ? "/d" : `/${period}d`;
        const id = inserted?.id ?? 0;
        const cmp = comparison ?? ">=";
        return {
          content: [
            {
              type: "text",
              text: `Added indication #${id}: ${label}  [${metric}${
                filter ? `:${filter}` : ""
              } ${cmp} ${target}${unit ? " " + unit : ""}${periodS}]`,
            },
          ],
          structuredContent: {
            id,
            label,
            metric,
            filter: filter ?? null,
            target,
            comparison: cmp,
            period_days: period,
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
            })
          ),
        },
      },
      async ({ include_inactive }) => {
        const where = include_inactive ? "" : "WHERE active = 1";
        const { results } = await db
          .prepare(
            `SELECT id, label, metric, filter, target, comparison, period_days, active
             FROM indications ${where}
             ORDER BY active DESC, id`
          )
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
          return `#${r.id}  ${r.active ? " " : "[off]"} ${r.label}  →  ${r.metric}${
            r.filter ? `:${r.filter}` : ""
          } ${r.comparison} ${r.target}${unit ? " " + unit : ""}${periodS}`;
        });
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: { count: results.length, indications: structured },
        };
      }
    );

    registerDeleteTool(this.server, db, {
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
            })
          ),
        },
      },
      async ({ date }) => {
        const now = new Date();
        const nowIso = now.toISOString();
        const day = date ?? madridDateOf(now);
        const dayStart = madridMidnightUtc(day);
        const { end } = madridDayWindow(day);
        // Gap metrics measure up to the end of the day for past days, or up
        // to now while the day is still running.
        const gapBoundary = end < nowIso ? end : nowIso;

        const [indRes, profileRes] = await db.batch([
          db.prepare(
            `SELECT id, label, metric, filter, target, comparison, period_days, active
             FROM indications WHERE active = 1 ORDER BY id`
          ),
          db.prepare(
            "SELECT name, sex, date_of_birth FROM profile WHERE id = 1"
          ),
        ]);
        const indications = indRes.results as IndicationRow[];
        const profile = (profileRes.results as ProfileRow[])[0];

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

        const ageS = profile?.date_of_birth
          ? `, ${computeAge(profile.date_of_birth, dayStart)}`
          : "";

        const actualResults = await db.batch(
          indications.map((ind) =>
            buildIndicationStatement(
              db,
              ind.metric,
              ind.filter,
              madridDayWindow(day, ind.period_days).start,
              end
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
        }> = [];
        let met = 0;
        for (let i = 0; i < indications.length; i++) {
          const ind = indications[i];
          const actual = extractIndicationActual(
            ind.metric,
            actualResults[i],
            gapBoundary
          );
          const ok =
            ind.comparison === ">="
              ? actual >= ind.target
              : actual <= ind.target;
          if (ok) met++;
          const unit = indicationUnit(ind.metric);
          const unitS = unit ? ` ${unit}` : "";
          const window =
            ind.period_days === 1 ? "/day" : ` over last ${ind.period_days} days`;
          lines.push(
            `${ok ? "[OK]  " : "[MISS]"} ${ind.label}  →  ${actual}${unitS} (target ${ind.comparison} ${ind.target}${unitS}${window})`
          );
          structured.push({
            id: ind.id,
            label: ind.label,
            metric: ind.metric,
            filter: ind.filter,
            target: ind.target,
            comparison: ind.comparison,
            period_days: ind.period_days,
            actual,
            unit,
            met: ok,
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
      async ({ window, since, until }) => {
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
          profileRow,
        ] = await db.batch([
          db.prepare(
            `SELECT
               COUNT(*)                    AS count,
               COALESCE(SUM(amount_ml), 0) AS total_ml,
               COALESCE(AVG(amount_ml), 0) AS avg_ml,
               MAX(ts)                     AS last_ts
             FROM feedings
             WHERE ts >= ? AND ts < ?`
          ).bind(start, end),
          db.prepare(
            `SELECT
               COUNT(*)                                                   AS event_count,
               SUM(CASE WHEN kind IN ('pee',  'both') THEN 1 ELSE 0 END)  AS pee_count,
               SUM(CASE WHEN kind IN ('poop', 'both') THEN 1 ELSE 0 END)  AS poop_count,
               MAX(ts)                                                    AS last_ts
             FROM diapers
             WHERE ts >= ? AND ts < ?`
          ).bind(start, end),
          db.prepare(
            `SELECT COUNT(*) AS count, MAX(ts) AS last_ts
             FROM routines
             WHERE ts >= ? AND ts < ?`
          ).bind(start, end),
          db.prepare(
            `SELECT name, COUNT(*) AS n
             FROM routines
             WHERE ts >= ? AND ts < ?
             GROUP BY name
             ORDER BY n DESC`
          ).bind(start, end),
          db.prepare(
            `SELECT COUNT(*) AS count, MAX(ts) AS last_ts
             FROM notes
             WHERE ts >= ? AND ts < ?`
          ).bind(start, end),
          db.prepare(
            "SELECT ts, weight_g FROM weights ORDER BY ts DESC LIMIT 1"
          ),
          db.prepare(
            "SELECT ts, height_cm FROM heights ORDER BY ts DESC LIMIT 1"
          ),
          db.prepare(
            "SELECT name, sex, date_of_birth FROM profile WHERE id = 1"
          ),
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

        const profile = (profileRow.results as ProfileRow[])[0];
        const latestWeight = (
          weightLatest.results as Array<{ ts: string; weight_g: number }>
        )[0];
        const latestHeight = (
          heightLatest.results as Array<{ ts: string; height_cm: number }>
        )[0];

        const lines: string[] = [];
        if (
          profile &&
          (profile.name || profile.sex || profile.date_of_birth)
        ) {
          const bits: string[] = [];
          if (profile.name) bits.push(profile.name);
          if (profile.sex) bits.push(profile.sex);
          if (profile.date_of_birth) bits.push(computeAge(profile.date_of_birth));
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
      async ({ events, when: defaultWhen }) => {
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
                  "INSERT INTO feedings (ts, amount_ml) VALUES (?, ?) RETURNING id"
                )
                .bind(ts, ev.amount_ml)
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
                  "INSERT INTO diapers (ts, kind) VALUES (?, ?) RETURNING id"
                )
                .bind(ts, ev.kind)
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
                  "INSERT INTO routines (ts, name) VALUES (?, ?) RETURNING id"
                )
                .bind(ts, ev.name)
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
                  "INSERT INTO notes (ts, text) VALUES (?, ?) RETURNING id"
                )
                .bind(ts, ev.text)
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
  }
}
