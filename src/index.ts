import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  OAuthProvider,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { handleAlexa } from "./alexa";
import { computeAgeParts, insertAndLookupPrev } from "./lib";

type Env = {
  DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  SHARED_SECRET?: string;
  ALEXA_APPLICATION_ID?: string;
  ALEXA_SKIP_SIGNATURE?: string;
};

type FeedingRow = {
  id: number;
  ts: string;
  amount_ml: number;
};

type DiaperKind = "pee" | "poop" | "both";

type DiaperRow = {
  id: number;
  ts: string;
  kind: DiaperKind;
};

type RoutineRow = {
  id: number;
  ts: string;
  name: string;
};

type NoteRow = {
  id: number;
  ts: string;
  text: string;
};

type WeightRow = {
  id: number;
  ts: string;
  weight_g: number;
};

type HeightRow = {
  id: number;
  ts: string;
  height_cm: number;
};

type ProfileRow = {
  name: string | null;
  sex: "male" | "female" | "other" | null;
  date_of_birth: string | null;
};

function computeAge(dob: string, at?: Date): string {
  const parts = computeAgeParts(dob, at);
  if (!parts) return "not yet born";
  const { days, weeks, remDays, years, months } = parts;
  if (days < 60) {
    if (weeks === 0) return `${days} day${days === 1 ? "" : "s"} old`;
    return `${days} days old (${weeks}w${remDays > 0 ? ` ${remDays}d` : ""})`;
  }
  if (years === 0) {
    return `${months} month${months === 1 ? "" : "s"} old (${days} days)`;
  }
  return `${years}y ${months}m old (${days} days)`;
}

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

function humanizeGap(deltaMs: number): string {
  if (deltaMs < 0) return "in the future";
  const totalMin = Math.round(deltaMs / 60000);
  if (totalMin < 1) return "<1 min";
  if (totalMin < 60) return `${totalMin} min`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h > 0 ? `${days}d ${h}h` : `${days}d`;
}

function formatGap(
  currentTs: string,
  prevTs: string | null,
  suffix = ""
): {
  gapStr: string | null;
  gapMin: number | null;
  gapNote: string;
} {
  if (!prevTs) return { gapStr: null, gapMin: null, gapNote: "" };
  const ms = new Date(currentTs).getTime() - new Date(prevTs).getTime();
  const gapStr = humanizeGap(ms);
  const tail = suffix ? ` ${suffix}` : "";
  return {
    gapStr,
    gapMin: Math.round(ms / 60000),
    gapNote: `  (${gapStr} since previous${tail})`,
  };
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

const DAY_MS = 86_400_000;
const WINDOW_OFFSET_MS = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
} as const;

function buildWindowClauses(since?: string, until?: string) {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (since) {
    clauses.push("ts >= ?");
    params.push(since);
  }
  if (until) {
    clauses.push("ts < ?");
    params.push(until);
  }
  return { clauses, params };
}

const limitField = z
  .number()
  .int()
  .positive()
  .max(500)
  .optional()
  .describe("Maximum number of rows to return (default 50, max 500)");

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
      return db
        .prepare(
          "SELECT ts FROM feedings WHERE ts >= ? AND ts < ? ORDER BY ts ASC"
        )
        .bind(start, end);
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

function extractIndicationActual(
  metric: IndicationMetric,
  result: D1Result<unknown>
): number {
  if (metric === "feeding_gap_max_min") {
    const rows = result.results as Array<{ ts: string }>;
    if (rows.length < 2) return 0;
    let maxGap = 0;
    for (let i = 1; i < rows.length; i++) {
      const gap = Math.round(
        (new Date(rows[i].ts).getTime() -
          new Date(rows[i - 1].ts).getTime()) /
          60000
      );
      if (gap > maxGap) maxGap = gap;
    }
    return maxGap;
  }
  const rows = result.results as Array<{ v: number }>;
  return rows[0]?.v ?? 0;
}

function indicationUnit(metric: IndicationMetric): string {
  if (metric === "feeding_total_ml") return "ml";
  if (metric === "feeding_gap_max_min") return "min";
  return "";
}

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect x="18" y="20" width="28" height="38" rx="6" fill="#fff" stroke="#0070f3" stroke-width="3"/>
  <path d="M 21 36 H 43 V 53 a 3 3 0 0 1 -3 3 H 24 a 3 3 0 0 1 -3 -3 Z" fill="#0070f3" opacity="0.35"/>
  <rect x="22" y="14" width="20" height="8" rx="2" fill="#fff" stroke="#0070f3" stroke-width="3"/>
  <path d="M 26 14 Q 26 6 32 6 Q 38 6 38 14" fill="#fff" stroke="#0070f3" stroke-width="3" stroke-linecap="round"/>
  <line x1="40" y1="28" x2="44" y2="28" stroke="#0070f3" stroke-width="2"/>
  <line x1="40" y1="38" x2="44" y2="38" stroke="#0070f3" stroke-width="2"/>
  <line x1="40" y1="48" x2="44" y2="48" stroke="#0070f3" stroke-width="2"/>
</svg>`;

const SERVER_ORIGIN = "https://baby-feeding-mcp.llera.workers.dev";

const WEB_MANIFEST = JSON.stringify({
  name: "Baby diary",
  short_name: "Baby diary",
  description:
    "Log feedings, diapers, routines, weights, heights, and notes.",
  start_url: "/app",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  background_color: "#fafafa",
  theme_color: "#0070f3",
  lang: "es",
  icons: [
    {
      src: "/icon.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any",
    },
    {
      src: "/icon.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "maskable",
    },
  ],
});

// Minimal pass-through service worker. Its presence (plus a fetch listener)
// is what some browsers — Opera Mobile included — still check for to enable
// "Install app" / standalone mode. We intentionally do not cache anything:
// auth cookies, MCP tokens and live diary data don't mix with stale caches.
const SERVICE_WORKER_JS = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
`;

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

        await this.env.DB.prepare(
          `UPDATE profile SET ${updates.join(", ")} WHERE id = 1`
        )
          .bind(...params)
          .run();

        const row = await this.env.DB.prepare(
          "SELECT name, sex, date_of_birth FROM profile WHERE id = 1"
        ).first<ProfileRow>();

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
        const row = await this.env.DB.prepare(
          "SELECT name, sex, date_of_birth FROM profile WHERE id = 1"
        ).first<ProfileRow>();
        let age: string | null = null;
        let ageDays: number | null = null;
        if (row?.date_of_birth) {
          age = computeAge(row.date_of_birth);
          const birth = new Date(`${row.date_of_birth}T00:00:00Z`);
          ageDays = Math.floor((Date.now() - birth.getTime()) / 86400000);
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
          when: z
            .string()
            .datetime()
            .optional()
            .describe(
              "Optional ISO 8601 timestamp (e.g. 2026-05-14T07:30:00Z). OMIT this when the feeding is happening now — the server fills in the current time. Only pass this if the user explicitly gave a different time."
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
        const ts = when ?? new Date().toISOString();
        const { id, prev } = await insertAndLookupPrev<{ ts: string }>(
          this.env.DB,
          this.env.DB.prepare(
            "SELECT ts FROM feedings WHERE ts < ? ORDER BY ts DESC LIMIT 1"
          ).bind(ts),
          this.env.DB.prepare(
            "INSERT INTO feedings (ts, amount_ml) VALUES (?, ?) RETURNING id"
          ).bind(ts, amount_ml)
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

    this.server.registerTool(
      "list_feedings",
      {
        description:
          "List recorded feedings, most recent first. Optionally filter by a time window and limit.",
        inputSchema: {
          since: z
            .string()
            .datetime()
            .optional()
            .describe("Include feedings on or after this ISO timestamp"),
          until: z
            .string()
            .datetime()
            .optional()
            .describe("Include feedings strictly before this ISO timestamp"),
          limit: limitField,
        },
        outputSchema: {
          count: z.number().int(),
          feedings: z.array(
            z.object({
              id: z.number().int(),
              ts: z.string(),
              amount_ml: z.number(),
            })
          ),
        },
      },
      async ({ since, until, limit }) => {
        const { clauses, params } = buildWindowClauses(since, until);
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        params.push(limit ?? 50);

        const { results } = await this.env.DB.prepare(
          `SELECT id, ts, amount_ml FROM feedings ${where} ORDER BY ts DESC LIMIT ?`
        )
          .bind(...params)
          .all<FeedingRow>();

        if (results.length === 0) {
          return {
            content: [
              { type: "text", text: "No feedings recorded in that range." },
            ],
            structuredContent: { count: 0, feedings: [] },
          };
        }

        const lines = results.map(
          (r) => `#${r.id}  ${r.ts}  ${r.amount_ml} ml`
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: { count: results.length, feedings: results },
        };
      }
    );

    this.server.registerTool(
      "delete_feeding",
      {
        description: "Delete a recorded feeding by its numeric id.",
        inputSchema: {
          id: z
            .number()
            .int()
            .positive()
            .describe("Feeding id to delete (from list_feedings)"),
        },
      },
      async ({ id }) => deleteById(this.env.DB, "feedings", "feeding", id)
    );

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
          when: z
            .string()
            .datetime()
            .optional()
            .describe(
              "Optional ISO 8601 timestamp (e.g. 2026-05-14T07:30:00Z). OMIT this when the change is happening now — the server fills in the current time. Only pass this if the user explicitly gave a different time."
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
        const ts = when ?? new Date().toISOString();
        const { id, prev } = await insertAndLookupPrev<{
          ts: string;
          kind: DiaperKind;
        }>(
          this.env.DB,
          this.env.DB.prepare(
            "SELECT ts, kind FROM diapers WHERE ts < ? ORDER BY ts DESC LIMIT 1"
          ).bind(ts),
          this.env.DB.prepare(
            "INSERT INTO diapers (ts, kind) VALUES (?, ?) RETURNING id"
          ).bind(ts, kind)
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

    this.server.registerTool(
      "list_diapers",
      {
        description:
          "List diaper events, most recent first. Optionally filter by time window and kind.",
        inputSchema: {
          since: z
            .string()
            .datetime()
            .optional()
            .describe("Include events on or after this ISO timestamp"),
          until: z
            .string()
            .datetime()
            .optional()
            .describe("Include events strictly before this ISO timestamp"),
          kind: z
            .enum(["pee", "poop", "both"])
            .optional()
            .describe("Filter to only pee, only poop, or only 'both' events"),
          limit: limitField,
        },
        outputSchema: {
          count: z.number().int(),
          diapers: z.array(
            z.object({
              id: z.number().int(),
              ts: z.string(),
              kind: z.enum(["pee", "poop", "both"]),
            })
          ),
        },
      },
      async ({ since, until, kind, limit }) => {
        const { clauses, params } = buildWindowClauses(since, until);
        if (kind) {
          clauses.push("kind = ?");
          params.push(kind);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        params.push(limit ?? 50);

        const { results } = await this.env.DB.prepare(
          `SELECT id, ts, kind FROM diapers ${where} ORDER BY ts DESC LIMIT ?`
        )
          .bind(...params)
          .all<DiaperRow>();

        if (results.length === 0) {
          return {
            content: [
              { type: "text", text: "No diaper events in that range." },
            ],
            structuredContent: { count: 0, diapers: [] },
          };
        }

        const lines = results.map(
          (r) => `#${r.id}  ${r.ts}  ${r.kind}`
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: { count: results.length, diapers: results },
        };
      }
    );

    this.server.registerTool(
      "delete_diaper",
      {
        description: "Delete a diaper event by its numeric id.",
        inputSchema: {
          id: z
            .number()
            .int()
            .positive()
            .describe("Diaper id to delete (from list_diapers)"),
        },
      },
      async ({ id }) => deleteById(this.env.DB, "diapers", "diaper", id)
    );

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
          when: z
            .string()
            .datetime()
            .optional()
            .describe(
              "Optional ISO 8601 timestamp (e.g. 2026-05-14T07:30:00Z). OMIT this when the event is happening now — the server fills in the current time."
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
        const ts = when ?? new Date().toISOString();
        const { id, prev } = await insertAndLookupPrev<{ ts: string }>(
          this.env.DB,
          this.env.DB.prepare(
            "SELECT ts FROM routines WHERE ts < ? AND LOWER(name) = LOWER(?) ORDER BY ts DESC LIMIT 1"
          ).bind(ts, name),
          this.env.DB.prepare(
            "INSERT INTO routines (ts, name) VALUES (?, ?) RETURNING id"
          ).bind(ts, name)
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

    this.server.registerTool(
      "list_routines",
      {
        description:
          "List routine-care entries and medication doses (e.g. Vitamin D doses, baths), most recent first. Optionally filter by time window and entry name (case-insensitive substring match).",
        inputSchema: {
          since: z
            .string()
            .datetime()
            .optional()
            .describe("Include entries on or after this ISO timestamp"),
          until: z
            .string()
            .datetime()
            .optional()
            .describe("Include entries strictly before this ISO timestamp"),
          name: z
            .string()
            .min(1)
            .max(100)
            .optional()
            .describe(
              "Filter by entry name (case-insensitive substring match, e.g. 'vitamin')"
            ),
          limit: limitField,
        },
        outputSchema: {
          count: z.number().int(),
          routines: z.array(
            z.object({
              id: z.number().int(),
              ts: z.string(),
              name: z.string(),
            })
          ),
        },
      },
      async ({ since, until, name, limit }) => {
        const { clauses, params } = buildWindowClauses(since, until);
        if (name) {
          clauses.push("LOWER(name) LIKE ?");
          params.push(`%${name.toLowerCase()}%`);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        params.push(limit ?? 50);

        const { results } = await this.env.DB.prepare(
          `SELECT id, ts, name FROM routines ${where} ORDER BY ts DESC LIMIT ?`
        )
          .bind(...params)
          .all<RoutineRow>();

        if (results.length === 0) {
          return {
            content: [
              { type: "text", text: "No routines recorded in that range." },
            ],
            structuredContent: { count: 0, routines: [] },
          };
        }

        const lines = results.map(
          (r) => `#${r.id}  ${r.ts}  ${r.name}`
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: { count: results.length, routines: results },
        };
      }
    );

    this.server.registerTool(
      "delete_routine",
      {
        description: "Delete a routine entry by its numeric id.",
        inputSchema: {
          id: z
            .number()
            .int()
            .positive()
            .describe("Routine id to delete (from list_routines)"),
        },
      },
      async ({ id }) => deleteById(this.env.DB, "routines", "routine", id)
    );

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
          when: z
            .string()
            .datetime()
            .optional()
            .describe(
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
        const ts = when ?? new Date().toISOString();
        const inserted = await this.env.DB.prepare(
          "INSERT INTO notes (ts, text) VALUES (?, ?) RETURNING id"
        )
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

    this.server.registerTool(
      "list_notes",
      {
        description:
          "List notes, most recent first. Optionally filter by time window or a substring of the text.",
        inputSchema: {
          since: z
            .string()
            .datetime()
            .optional()
            .describe("Include notes on or after this ISO timestamp"),
          until: z
            .string()
            .datetime()
            .optional()
            .describe("Include notes strictly before this ISO timestamp"),
          search: z
            .string()
            .min(1)
            .max(200)
            .optional()
            .describe(
              "Substring to search for inside the note text (case-insensitive)"
            ),
          limit: limitField,
        },
        outputSchema: {
          count: z.number().int(),
          notes: z.array(
            z.object({
              id: z.number().int(),
              ts: z.string(),
              text: z.string(),
            })
          ),
        },
      },
      async ({ since, until, search, limit }) => {
        const { clauses, params } = buildWindowClauses(since, until);
        if (search) {
          clauses.push("LOWER(text) LIKE ?");
          params.push(`%${search.toLowerCase()}%`);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        params.push(limit ?? 50);

        const { results } = await this.env.DB.prepare(
          `SELECT id, ts, text FROM notes ${where} ORDER BY ts DESC LIMIT ?`
        )
          .bind(...params)
          .all<NoteRow>();

        if (results.length === 0) {
          return {
            content: [
              { type: "text", text: "No notes recorded in that range." },
            ],
            structuredContent: { count: 0, notes: [] },
          };
        }

        const lines = results.map(
          (r) => `#${r.id}  ${r.ts}  ${r.text}`
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: { count: results.length, notes: results },
        };
      }
    );

    this.server.registerTool(
      "delete_note",
      {
        description: "Delete a note by its numeric id.",
        inputSchema: {
          id: z
            .number()
            .int()
            .positive()
            .describe("Note id to delete (from list_notes)"),
        },
      },
      async ({ id }) => deleteById(this.env.DB, "notes", "note", id)
    );

    this.server.registerTool(
      "record_weight",
      {
        description:
          "Record a baby weight measurement in whole grams. If the user does not specify a time, OMIT the `when` parameter — the server uses the current time.",
        inputSchema: {
          weight_g: z
            .number()
            .int()
            .positive()
            .describe(
              "Weight in whole grams, e.g. 4250. If the user gives kilograms, pounds, or decimals, convert and round first (1 kg = 1000 g)."
            ),
          when: z
            .string()
            .datetime()
            .optional()
            .describe(
              "Optional ISO 8601 timestamp. OMIT this when the measurement is happening now."
            ),
        },
        outputSchema: {
          id: z.number().int(),
          ts: z.string(),
          weight_g: z.number().int(),
          delta_g: z.number().int().nullable(),
          previous_ts: z.string().nullable(),
          previous_weight_g: z.number().int().nullable(),
        },
      },
      async ({ weight_g, when }) => {
        const ts = when ?? new Date().toISOString();
        const { id, prev } = await insertAndLookupPrev<{
          ts: string;
          weight_g: number;
        }>(
          this.env.DB,
          this.env.DB.prepare(
            "SELECT ts, weight_g FROM weights WHERE ts < ? ORDER BY ts DESC LIMIT 1"
          ).bind(ts),
          this.env.DB.prepare(
            "INSERT INTO weights (ts, weight_g) VALUES (?, ?) RETURNING id"
          ).bind(ts, weight_g)
        );

        let delta = "";
        let diff: number | null = null;
        if (prev) {
          diff = weight_g - prev.weight_g;
          const sign = diff >= 0 ? "+" : "";
          delta = `  (${sign}${diff} g since ${prev.ts})`;
        }

        return {
          content: [
            {
              type: "text",
              text: `Recorded weight #${id}: ${weight_g} g at ${ts}${delta}.`,
            },
          ],
          structuredContent: {
            id,
            ts,
            weight_g,
            delta_g: diff,
            previous_ts: prev?.ts ?? null,
            previous_weight_g: prev?.weight_g ?? null,
          },
        };
      }
    );

    this.server.registerTool(
      "list_weights",
      {
        description:
          "List weight measurements, most recent first. Optionally filter by time window.",
        inputSchema: {
          since: z
            .string()
            .datetime()
            .optional()
            .describe("Include measurements on or after this ISO timestamp"),
          until: z
            .string()
            .datetime()
            .optional()
            .describe("Include measurements strictly before this ISO timestamp"),
          limit: limitField,
        },
        outputSchema: {
          count: z.number().int(),
          weights: z.array(
            z.object({
              id: z.number().int(),
              ts: z.string(),
              weight_g: z.number().int(),
            })
          ),
        },
      },
      async ({ since, until, limit }) => {
        const { clauses, params } = buildWindowClauses(since, until);
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        params.push(limit ?? 50);

        const { results } = await this.env.DB.prepare(
          `SELECT id, ts, weight_g FROM weights ${where} ORDER BY ts DESC LIMIT ?`
        )
          .bind(...params)
          .all<WeightRow>();

        if (results.length === 0) {
          return {
            content: [
              { type: "text", text: "No weight measurements in that range." },
            ],
            structuredContent: { count: 0, weights: [] },
          };
        }

        const lines = results.map(
          (r) =>
            `#${r.id}  ${r.ts}  ${r.weight_g} g`
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: { count: results.length, weights: results },
        };
      }
    );

    this.server.registerTool(
      "delete_weight",
      {
        description: "Delete a weight measurement by its numeric id.",
        inputSchema: {
          id: z
            .number()
            .int()
            .positive()
            .describe("Weight id to delete (from list_weights)"),
        },
      },
      async ({ id }) => deleteById(this.env.DB, "weights", "weight", id)
    );

    this.server.registerTool(
      "record_height",
      {
        description:
          "Record a baby length/height measurement in whole centimeters (babies are measured lying down, so this is technically length). If the user does not specify a time, OMIT the `when` parameter — the server uses the current time.",
        inputSchema: {
          height_cm: z
            .number()
            .int()
            .positive()
            .describe(
              "Length/height in whole centimeters, e.g. 54. If given in inches, meters, or with decimals, convert and round first."
            ),
          when: z
            .string()
            .datetime()
            .optional()
            .describe(
              "Optional ISO 8601 timestamp. OMIT this when the measurement is happening now."
            ),
        },
        outputSchema: {
          id: z.number().int(),
          ts: z.string(),
          height_cm: z.number().int(),
          delta_cm: z.number().int().nullable(),
          previous_ts: z.string().nullable(),
          previous_height_cm: z.number().int().nullable(),
        },
      },
      async ({ height_cm, when }) => {
        const ts = when ?? new Date().toISOString();
        const { id, prev } = await insertAndLookupPrev<{
          ts: string;
          height_cm: number;
        }>(
          this.env.DB,
          this.env.DB.prepare(
            "SELECT ts, height_cm FROM heights WHERE ts < ? ORDER BY ts DESC LIMIT 1"
          ).bind(ts),
          this.env.DB.prepare(
            "INSERT INTO heights (ts, height_cm) VALUES (?, ?) RETURNING id"
          ).bind(ts, height_cm)
        );

        let delta = "";
        let diff: number | null = null;
        if (prev) {
          diff = height_cm - prev.height_cm;
          const sign = diff >= 0 ? "+" : "";
          delta = `  (${sign}${diff} cm since ${prev.ts})`;
        }

        return {
          content: [
            {
              type: "text",
              text: `Recorded height #${id}: ${height_cm} cm at ${ts}${delta}.`,
            },
          ],
          structuredContent: {
            id,
            ts,
            height_cm,
            delta_cm: diff,
            previous_ts: prev?.ts ?? null,
            previous_height_cm: prev?.height_cm ?? null,
          },
        };
      }
    );

    this.server.registerTool(
      "list_heights",
      {
        description:
          "List height/length measurements, most recent first. Optionally filter by time window.",
        inputSchema: {
          since: z
            .string()
            .datetime()
            .optional()
            .describe("Include measurements on or after this ISO timestamp"),
          until: z
            .string()
            .datetime()
            .optional()
            .describe("Include measurements strictly before this ISO timestamp"),
          limit: limitField,
        },
        outputSchema: {
          count: z.number().int(),
          heights: z.array(
            z.object({
              id: z.number().int(),
              ts: z.string(),
              height_cm: z.number().int(),
            })
          ),
        },
      },
      async ({ since, until, limit }) => {
        const { clauses, params } = buildWindowClauses(since, until);
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        params.push(limit ?? 50);

        const { results } = await this.env.DB.prepare(
          `SELECT id, ts, height_cm FROM heights ${where} ORDER BY ts DESC LIMIT ?`
        )
          .bind(...params)
          .all<HeightRow>();

        if (results.length === 0) {
          return {
            content: [
              { type: "text", text: "No height measurements in that range." },
            ],
            structuredContent: { count: 0, heights: [] },
          };
        }

        const lines = results.map(
          (r) =>
            `#${r.id}  ${r.ts}  ${r.height_cm} cm`
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: { count: results.length, heights: results },
        };
      }
    );

    this.server.registerTool(
      "delete_height",
      {
        description: "Delete a height measurement by its numeric id.",
        inputSchema: {
          id: z
            .number()
            .int()
            .positive()
            .describe("Height id to delete (from list_heights)"),
        },
      },
      async ({ id }) => deleteById(this.env.DB, "heights", "height", id)
    );

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
            "What to aggregate: feeding_total_ml (sum of feeding ml), feeding_count, feeding_gap_max_min (max minutes between consecutive feedings in the window — use with comparison='<='), diaper_count, routine_count, note_count"
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

        const inserted = await this.env.DB.prepare(
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
        const { results } = await this.env.DB.prepare(
          `SELECT id, label, metric, filter, target, comparison, period_days, active
           FROM indications ${where}
           ORDER BY active DESC, id`
        ).all<IndicationRow>();

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

    this.server.registerTool(
      "delete_indication",
      {
        description: "Delete an indication by its numeric id.",
        inputSchema: {
          id: z
            .number()
            .int()
            .positive()
            .describe("Indication id (from list_indications)"),
        },
      },
      async ({ id }) =>
        deleteById(this.env.DB, "indications", "indication", id)
    );

    this.server.registerTool(
      "check_indications",
      {
        description:
          "Evaluate all active indications against a day's actuals. Reports which are met ([OK]) and which are missed ([MISS]). Defaults to today (UTC).",
        inputSchema: {
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe(
              "ISO date YYYY-MM-DD (UTC) to evaluate. Defaults to today."
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
        const day = date ?? new Date().toISOString().slice(0, 10);
        const dayStart = new Date(`${day}T00:00:00.000Z`);
        const endDate = new Date(dayStart);
        endDate.setUTCDate(endDate.getUTCDate() + 1);
        const end = endDate.toISOString();

        const [indRes, profileRes] = await this.env.DB.batch([
          this.env.DB.prepare(
            `SELECT id, label, metric, filter, target, comparison, period_days, active
             FROM indications WHERE active = 1 ORDER BY id`
          ),
          this.env.DB.prepare(
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

        const starts = indications.map((ind) => {
          const startDate = new Date(dayStart);
          startDate.setUTCDate(startDate.getUTCDate() - (ind.period_days - 1));
          return startDate.toISOString();
        });
        const actualResults = await this.env.DB.batch(
          indications.map((ind, i) =>
            buildIndicationStatement(
              this.env.DB,
              ind.metric,
              ind.filter,
              starts[i],
              end
            )
          )
        );

        const lines: string[] = [`Indications evaluated as of ${day} (UTC${ageS}):`];
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
          const actual = extractIndicationActual(ind.metric, actualResults[i]);
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
              "Quick preset. '24h' = last 24 hours; 'today' = since UTC midnight; '7d' = last 7×24h; '30d' = last 30×24h. If set, ignores `since`/`until`."
            ),
          since: z
            .string()
            .datetime()
            .optional()
            .describe("Start of the window (ISO timestamp). Default: 24h ago."),
          until: z
            .string()
            .datetime()
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
          const d = new Date(now);
          d.setUTCHours(0, 0, 0, 0);
          start = d.toISOString();
          end = nowIso;
        } else if (window) {
          start = new Date(now - WINDOW_OFFSET_MS[window]).toISOString();
          end = nowIso;
        } else {
          end = until ?? nowIso;
          start = since ?? new Date(now - DAY_MS).toISOString();
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
        ] = await this.env.DB.batch([
          this.env.DB.prepare(
            `SELECT
               COUNT(*)                    AS count,
               COALESCE(SUM(amount_ml), 0) AS total_ml,
               COALESCE(AVG(amount_ml), 0) AS avg_ml,
               MAX(ts)                     AS last_ts
             FROM feedings
             WHERE ts >= ? AND ts < ?`
          ).bind(start, end),
          this.env.DB.prepare(
            `SELECT
               COUNT(*)                                                   AS event_count,
               SUM(CASE WHEN kind IN ('pee',  'both') THEN 1 ELSE 0 END)  AS pee_count,
               SUM(CASE WHEN kind IN ('poop', 'both') THEN 1 ELSE 0 END)  AS poop_count,
               MAX(ts)                                                    AS last_ts
             FROM diapers
             WHERE ts >= ? AND ts < ?`
          ).bind(start, end),
          this.env.DB.prepare(
            `SELECT COUNT(*) AS count, MAX(ts) AS last_ts
             FROM routines
             WHERE ts >= ? AND ts < ?`
          ).bind(start, end),
          this.env.DB.prepare(
            `SELECT name, COUNT(*) AS n
             FROM routines
             WHERE ts >= ? AND ts < ?
             GROUP BY name
             ORDER BY n DESC`
          ).bind(start, end),
          this.env.DB.prepare(
            `SELECT COUNT(*) AS count, MAX(ts) AS last_ts
             FROM notes
             WHERE ts >= ? AND ts < ?`
          ).bind(start, end),
          this.env.DB.prepare(
            "SELECT ts, weight_g FROM weights ORDER BY ts DESC LIMIT 1"
          ),
          this.env.DB.prepare(
            "SELECT ts, height_cm FROM heights ORDER BY ts DESC LIMIT 1"
          ),
          this.env.DB.prepare(
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
          "Record several events at once when the user mentions multiple things in one breath (e.g. 'I gave her Vitamin D, bathed her and did tummy time'). Use this instead of multiple separate calls so the response stays tidy. Each event picks one `type` plus its own required fields. Inserts are issued as a single D1 batch, so the call is atomic — if one INSERT fails, none are recorded and the error is returned.",
        inputSchema: {
          when: z
            .string()
            .datetime()
            .optional()
            .describe(
              "Default ISO 8601 UTC timestamp applied to events that omit their own `when`. Omit to use the current server time. Per-event `when` overrides this."
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
                  .datetime()
                  .optional()
                  .describe(
                    "Per-event ISO 8601 UTC timestamp; overrides the top-level `when`"
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
        const defaultTs = defaultWhen ?? new Date().toISOString();
        type EvType = "feeding" | "diaper" | "routine" | "note";
        const stmts: D1PreparedStatement[] = [];
        const stmtMeta: Array<{ type: EvType; ts: string }> = [];
        const errors: string[] = [];

        for (let i = 0; i < events.length; i++) {
          const ev = events[i];
          const ts = ev.when ?? defaultTs;
          if (ev.type === "feeding") {
            if (ev.amount_ml === undefined) {
              errors.push(`event #${i}: feeding requires amount_ml`);
              continue;
            }
            stmts.push(
              this.env.DB.prepare(
                "INSERT INTO feedings (ts, amount_ml) VALUES (?, ?) RETURNING id"
              ).bind(ts, ev.amount_ml)
            );
            stmtMeta.push({ type: "feeding", ts });
          } else if (ev.type === "diaper") {
            if (!ev.kind) {
              errors.push(`event #${i}: diaper requires kind`);
              continue;
            }
            stmts.push(
              this.env.DB.prepare(
                "INSERT INTO diapers (ts, kind) VALUES (?, ?) RETURNING id"
              ).bind(ts, ev.kind)
            );
            stmtMeta.push({ type: "diaper", ts });
          } else if (ev.type === "routine") {
            if (!ev.name) {
              errors.push(`event #${i}: routine requires name`);
              continue;
            }
            stmts.push(
              this.env.DB.prepare(
                "INSERT INTO routines (ts, name) VALUES (?, ?) RETURNING id"
              ).bind(ts, ev.name)
            );
            stmtMeta.push({ type: "routine", ts });
          } else if (ev.type === "note") {
            if (!ev.text) {
              errors.push(`event #${i}: note requires text`);
              continue;
            }
            stmts.push(
              this.env.DB.prepare(
                "INSERT INTO notes (ts, text) VALUES (?, ?) RETURNING id"
              ).bind(ts, ev.text)
            );
            stmtMeta.push({ type: "note", ts });
          }
        }

        const recorded: Array<{ type: EvType; id: number; ts: string }> = [];
        if (stmts.length > 0) {
          try {
            const batchResults = await this.env.DB.batch<{ id: number }>(
              stmts
            );
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
        }

        const lines: string[] = recorded.map(
          (r) => `Recorded ${r.type} #${r.id} at ${r.ts}.`
        );
        if (errors.length > 0) {
          lines.push("", "Errors:");
          for (const err of errors) lines.push(`  - ${err}`);
        }
        if (recorded.length === 0 && errors.length === 0) {
          lines.push("No events recorded.");
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

// -----------------------------------------------------------------------------
// OAuth: a single shared password gates access.
// `SHARED_SECRET` is a wrangler secret. Anyone with it can authorize an MCP
// client; once approved, the client gets a normal OAuth bearer token.
// -----------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderConsent(
  clientName: string,
  state: string,
  error?: string
): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize ${escapeHtml(clientName)}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         max-width:420px;margin:60px auto;padding:24px;line-height:1.5}
    .card{border:1px solid #ddd;border-radius:8px;padding:28px;
          box-shadow:0 2px 8px rgba(0,0,0,.06)}
    h1{margin:0 0 12px;font-size:1.25rem}
    label{display:block;margin:18px 0 6px;font-weight:600}
    input[type=password]{width:100%;padding:10px;border:1px solid #ccc;
          border-radius:4px;font-size:16px;box-sizing:border-box}
    button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:4px;
           background:#0070f3;color:#fff;font-size:16px;cursor:pointer}
    .err{background:#fee;border:1px solid #fcc;color:#900;padding:10px;
         border-radius:4px;margin-top:14px;font-size:14px}
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize <em>${escapeHtml(clientName)}</em></h1>
    <p>This MCP client wants to access the baby diary.</p>
    <form method="POST" action="/authorize">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <label for="pw">Server password</label>
      <input id="pw" type="password" name="password" autocomplete="current-password" autofocus required>
      ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: error ? 401 : 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function handleAuthorizeGet(
  request: Request,
  env: Env
): Promise<Response> {
  const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  if (!client) {
    return new Response("Invalid client_id", { status: 400 });
  }
  const state = btoa(JSON.stringify(oauthReq));
  return renderConsent(client.clientName ?? "MCP Client", state);
}

async function handleAuthorizePost(
  request: Request,
  env: Env
): Promise<Response> {
  const form = await request.formData();
  const state = form.get("state");
  const password = form.get("password");

  if (typeof state !== "string") {
    return new Response("Missing state", { status: 400 });
  }
  if (typeof password !== "string") {
    return new Response("Missing password", { status: 400 });
  }
  if (!env.SHARED_SECRET) {
    return new Response(
      "Server not configured: run `wrangler secret put SHARED_SECRET`.",
      { status: 500, headers: { "Content-Type": "text/plain" } }
    );
  }

  let oauthReq: AuthRequest;
  try {
    oauthReq = JSON.parse(atob(state)) as AuthRequest;
  } catch {
    return new Response("Invalid state", { status: 400 });
  }

  if (password !== env.SHARED_SECRET) {
    const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
    return renderConsent(
      client?.clientName ?? "MCP Client",
      state,
      "Incorrect password."
    );
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: "owner",
    metadata: { label: "Baby feeding tracker" },
    scope: oauthReq.scope,
    props: { user: "owner" },
  });
  return Response.redirect(redirectTo, 302);
}

// -----------------------------------------------------------------------------
// Web app: a browser-based UI for registering and removing entries.
// Auth is a single-password login (the same SHARED_SECRET) that issues an
// HttpOnly session cookie. The cookie value is HMAC-SHA256(SHARED_SECRET, "v1")
// so the server can verify it by recomputing — no session store needed.
// -----------------------------------------------------------------------------

const SESSION_COOKIE = "bf_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

async function deriveSessionToken(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode("bf-app-session-v1")
  );
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function isWebAuthorized(request: Request, env: Env): Promise<boolean> {
  if (!env.SHARED_SECRET) return false;
  const cookies = parseCookies(request.headers.get("Cookie"));
  const token = cookies.get(SESSION_COOKIE);
  if (!token) return false;
  const expected = await deriveSessionToken(env.SHARED_SECRET);
  return constantTimeEqual(token, expected);
}

function sessionCookieHeader(token: string, isHttps: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE}`,
  ];
  if (isHttps) parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookieHeader(isHttps: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (isHttps) parts.push("Secure");
  return parts.join("; ");
}

function renderAppLogin(error?: string, next?: string): Response {
  const nextAttr = next ? `<input type="hidden" name="next" value="${escapeHtml(next)}">` : "";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Baby diary — Log in</title>
  <link rel="icon" href="/icon.svg">
  <link rel="manifest" href="/manifest.webmanifest">
  <meta name="theme-color" content="#0070f3">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="Baby diary">
  <link rel="apple-touch-icon" href="/icon.svg">
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         max-width:420px;margin:60px auto;padding:24px;line-height:1.5;color:#222}
    .card{border:1px solid #ddd;border-radius:8px;padding:28px;
          box-shadow:0 2px 8px rgba(0,0,0,.06);background:#fff}
    h1{margin:0 0 12px;font-size:1.25rem}
    label{display:block;margin:18px 0 6px;font-weight:600}
    input[type=password]{width:100%;padding:10px;border:1px solid #ccc;
          border-radius:4px;font-size:16px;box-sizing:border-box}
    button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:4px;
           background:#0070f3;color:#fff;font-size:16px;cursor:pointer}
    .err{background:#fee;border:1px solid #fcc;color:#900;padding:10px;
         border-radius:4px;margin-top:14px;font-size:14px}
    p{color:#666;font-size:14px;margin:6px 0 0}
  </style>
</head>
<body>
  <div class="card">
    <h1>Baby diary</h1>
    <p>Log in to record feedings, diapers, routines, weights, heights, and notes.</p>
    <form method="POST" action="/app/login">
      ${nextAttr}
      <label for="pw">Password</label>
      <input id="pw" type="password" name="password" autocomplete="current-password" autofocus required>
      ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
      <button type="submit">Log in</button>
    </form>
  </div>
  <script>
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
      });
    }
  </script>
</body>
</html>`;
  return new Response(html, {
    status: error ? 401 : 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return "/app";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/app";
  return raw;
}

async function handleAppLoginGet(request: Request): Promise<Response> {
  const next = new URL(request.url).searchParams.get("next");
  return renderAppLogin(undefined, safeNextPath(next));
}

async function handleAppLoginPost(request: Request, env: Env): Promise<Response> {
  if (!env.SHARED_SECRET) {
    return new Response(
      "Server not configured: run `wrangler secret put SHARED_SECRET`.",
      { status: 500, headers: { "Content-Type": "text/plain" } }
    );
  }
  const form = await request.formData();
  const password = form.get("password");
  const next = safeNextPath(form.get("next") as string | null);
  if (typeof password !== "string") {
    return renderAppLogin("Password is missing.", next);
  }
  if (password !== env.SHARED_SECRET) {
    return renderAppLogin("Incorrect password.", next);
  }
  const token = await deriveSessionToken(env.SHARED_SECRET);
  const isHttps = new URL(request.url).protocol === "https:";
  return new Response(null, {
    status: 303,
    headers: {
      Location: next,
      "Set-Cookie": sessionCookieHeader(token, isHttps),
    },
  });
}

function handleAppLogout(request: Request): Response {
  const isHttps = new URL(request.url).protocol === "https:";
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/app/login",
      "Set-Cookie": clearSessionCookieHeader(isHttps),
    },
  });
}

const WHEN_BLOCK = `          <input type="hidden" name="when" value="">
          <div class="when-display" data-when-display>Now</div>
          <div class="when-quick">
            <button type="button" data-step="-60">&minus;1h</button>
            <button type="button" data-step="-15">&minus;15m</button>
            <button type="button" data-step="-5">&minus;5m</button>
            <button type="button" data-now>Now</button>
            <button type="button" data-step="5">+5m</button>
            <button type="button" data-step="15">+15m</button>
          </div>`;

const APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Baby diary</title>
  <link rel="icon" href="/icon.svg">
  <link rel="manifest" href="/manifest.webmanifest">
  <meta name="theme-color" content="#0070f3">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="Baby diary">
  <link rel="apple-touch-icon" href="/icon.svg">
  <style>
    :root {
      --primary: #0070f3;
      --primary-dark: #0058c4;
      --bg: #fafafa;
      --card: #fff;
      --border: #e2e2e2;
      --text: #1a1a1a;
      --muted: #666;
      --danger: #d33;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    header {
      background: var(--card);
      border-bottom: 1px solid var(--border);
      padding: 12px 20px;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    nav {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
      flex: 1;
    }
    nav button {
      background: transparent;
      border: 1px solid transparent;
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      color: var(--muted);
      font-family: inherit;
    }
    nav button:hover { background: #f0f0f0; }
    nav button.active {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
    }
    nav button.active:hover { background: var(--primary-dark); }
    /* Desktop default: More menu vanishes, its tabs flow inline as nav children. */
    .more-menu,
    .more-dropdown,
    .more-dropdown[hidden] { display: contents; }
    #more-btn { display: none; }
    main {
      max-width: 920px;
      margin: 24px auto;
      padding: 0 16px 40px;
    }
    .tab { display: none; }
    .tab.active { display: block; }
    form.entry-form {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 18px;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: flex-end;
    }
    form.entry-form label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
      flex: 1 1 140px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    form.entry-form input,
    form.entry-form select {
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 14px;
      font-family: inherit;
      color: var(--text);
      background: #fff;
      text-transform: none;
      letter-spacing: normal;
      font-weight: 400;
    }
    form.entry-form input:focus,
    form.entry-form select:focus {
      outline: 2px solid var(--primary);
      outline-offset: -1px;
      border-color: var(--primary);
    }
    form.entry-form button[type=submit] {
      background: var(--primary);
      color: white;
      border: 0;
      padding: 10px 20px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      font-family: inherit;
      align-self: flex-end;
    }
    form.entry-form button[type=submit]:hover { background: var(--primary-dark); }
    form.entry-form button[type=submit]:disabled { opacity: 0.5; cursor: not-allowed; }
    .list {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }
    .list-empty,
    .list-loading {
      padding: 28px 16px;
      text-align: center;
      color: var(--muted);
      font-size: 14px;
    }
    table { width: 100%; border-collapse: collapse; }
    th, td {
      text-align: left;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      font-size: 14px;
      vertical-align: top;
    }
    th {
      background: #f7f7f8;
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
    }
    tbody tr:last-child td { border-bottom: 0; }
    tbody tr:hover { background: #fafafa; }
    .ts-col { white-space: nowrap; font-variant-numeric: tabular-nums; }
    .num-col { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .actions-col { text-align: right; width: 1%; white-space: nowrap; }
    .delete-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--danger);
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      font-family: inherit;
    }
    .delete-btn:hover { background: #fee; border-color: var(--danger); }
    .toast {
      position: fixed;
      bottom: 18px;
      left: 50%;
      transform: translateX(-50%);
      background: #222;
      color: #fff;
      padding: 10px 16px;
      border-radius: 6px;
      font-size: 14px;
      box-shadow: 0 4px 16px rgba(0,0,0,.2);
      opacity: 0;
      transition: opacity .2s;
      pointer-events: none;
      z-index: 10;
    }
    .toast.show { opacity: 1; }
    .toast.error { background: var(--danger); }
    .dashboard-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 14px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
      display: flex;
      flex-direction: column;
    }
    .card-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 8px;
    }
    .card-main {
      font-size: 22px;
      font-weight: 700;
      line-height: 1.2;
    }
    .card-sub {
      font-size: 13px;
      color: var(--muted);
      margin-top: 2px;
    }
    .card-empty {
      font-size: 14px;
      color: var(--muted);
      font-style: italic;
    }
    .week-chart {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .chart-head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    .chart-head .card-title { margin: 0; flex: 1; text-align: center; }
    .chart-nav {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 6px;
      padding: 4px 10px;
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      font-family: inherit;
    }
    .chart-nav:hover:not(:disabled) { background: #f0f0f0; }
    .chart-nav:disabled { opacity: 0.35; cursor: not-allowed; }
    .chart-bars {
      display: flex;
      align-items: flex-end;
      gap: 6px;
      height: 160px;
    }
    .chart-bar {
      flex: 1 1 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-end;
      height: 100%;
      min-width: 0;
      cursor: pointer;
      border-radius: 6px;
    }
    .chart-bar:hover { background: #f5f5f5; }
    .chart-bar.selected { background: #eaf2ff; }
    .chart-bar.selected .chart-bar-label { color: var(--primary); font-weight: 700; }
    .chart-bar-val {
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      color: var(--muted);
      margin-bottom: 4px;
      white-space: nowrap;
    }
    .chart-bar-fill {
      width: 100%;
      max-width: 44px;
      background: var(--primary);
      border-radius: 4px 4px 0 0;
      min-height: 2px;
      transition: height .2s;
    }
    .chart-bar.today .chart-bar-fill { background: var(--primary-dark); }
    .chart-bar-label {
      font-size: 11px;
      color: var(--muted);
      margin-top: 6px;
      white-space: nowrap;
    }
    .chart-bar.today .chart-bar-label { color: var(--text); font-weight: 700; }
    /* Diaper chart: two bars (pee/poop) per day */
    .chart-pair {
      flex: 1 1 auto;
      width: 100%;
      display: flex;
      align-items: flex-end;
      justify-content: center;
      gap: 3px;
    }
    .chart-sub {
      flex: 1 1 0;
      min-width: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-end;
      height: 100%;
    }
    .chart-pair .chart-bar-fill { max-width: 20px; }
    .chart-bar-fill.pee { background: var(--primary); }
    .chart-bar-fill.poop { background: #b5651d; }
    .chart-bar.today .chart-bar-fill.poop { background: #8f4f17; }
    .chart-legend {
      display: flex;
      gap: 16px;
      justify-content: center;
      margin-bottom: 10px;
      font-size: 12px;
      color: var(--muted);
    }
    .chart-legend span { display: inline-flex; align-items: center; gap: 5px; }
    .chart-legend i {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      display: inline-block;
    }
    .chart-legend i.pee { background: var(--primary); }
    .chart-legend i.poop { background: #b5651d; }
    .quick-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .quick-btn {
      background: var(--primary);
      color: #fff;
      border: 0;
      padding: 9px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      font-family: inherit;
      min-height: 38px;
    }
    .quick-btn:hover { background: var(--primary-dark); }
    .quick-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .totals-row {
      display: flex;
      gap: 18px;
      flex-wrap: wrap;
      margin-top: 4px;
    }
    .totals-item .totals-num {
      font-size: 20px;
      font-weight: 700;
      line-height: 1.1;
    }
    .totals-item .totals-label {
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-top: 2px;
    }
    .when-quick {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
      margin-top: 4px;
    }
    .when-quick button {
      background: #f0f0f0;
      border: 1px solid var(--border);
      padding: 4px 8px;
      font-size: 12px;
      border-radius: 4px;
      cursor: pointer;
      font-family: inherit;
      color: var(--muted);
      text-transform: none;
      letter-spacing: normal;
      font-weight: 500;
    }
    .when-quick button:hover { background: #e5e5e5; color: var(--text); }
    .when-quick button[data-now] {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
      font-weight: 600;
    }
    .when-quick button[data-now]:hover {
      background: var(--primary-dark);
      color: #fff;
    }
    .choice-group {
      display: flex;
      gap: 4px;
      margin-top: 4px;
    }
    .choice-btn {
      flex: 1 1 0;
      background: #f7f7f8;
      border: 1px solid var(--border);
      padding: 10px 8px;
      border-radius: 6px;
      cursor: pointer;
      font-family: inherit;
      font-size: 14px;
      font-weight: 500;
      color: var(--muted);
      text-transform: none;
      letter-spacing: normal;
      min-height: 40px;
    }
    .choice-btn:hover { background: #efeff1; color: var(--text); }
    .choice-btn.active {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
    }
    .choice-btn.active:hover { background: var(--primary-dark); color: #fff; }
    .when-display {
      display: block;
      padding: 6px 10px;
      background: #f4f4f6;
      border-radius: 4px;
      font-size: 16px;
      font-family: inherit;
      color: var(--text);
      text-transform: none;
      letter-spacing: normal;
      font-weight: 400;
      text-align: center;
    }
    .delete-btn.pending {
      background: var(--danger);
      color: #fff;
      border-color: var(--danger);
      font-weight: 600;
    }
    .delete-btn.pending:hover { background: #b22; }
    @media (max-width: 640px) {
      header { padding: 8px 10px; gap: 8px; }
      nav { gap: 3px; }
      nav button { padding: 5px 9px; font-size: 13px; border-radius: 5px; }
      /* Mobile: restore the More dropdown — its tabs live behind the ⋯ button. */
      .more-menu { display: inline-block; position: relative; }
      #more-btn { display: inline-block; font-size: 18px; line-height: 1; padding: 5px 9px; }
      .more-dropdown {
        display: flex;
        flex-direction: column;
        position: absolute;
        top: 100%;
        right: 0;
        margin-top: 4px;
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0,0,0,.08);
        padding: 4px;
        min-width: 140px;
        z-index: 20;
      }
      .more-dropdown[hidden] { display: none; }
      .more-dropdown button { text-align: left; width: 100%; }
      main { margin: 14px auto; padding: 0 10px 24px; }
      th, td { padding: 8px 10px; }
      .hide-sm { display: none; }

      .dashboard-grid {
        grid-template-columns: repeat(2, 1fr);
        gap: 8px;
      }
      #card-today-totals { grid-column: 1 / -1; }
      .card { padding: 10px 12px; }
      .card-title { margin-bottom: 4px; font-size: 10px; }
      .card-main { font-size: 16px; }
      .card-sub { font-size: 12px; }
      .card-empty { font-size: 13px; }
      .quick-row { gap: 6px; margin-top: 8px; }
      .quick-btn { padding: 7px 10px; font-size: 13px; min-height: 32px; }
      .totals-row { gap: 12px; }
      .totals-item .totals-num { font-size: 17px; }
      .totals-item .totals-label { font-size: 10px; }

      form.entry-form { padding: 12px; gap: 8px; margin-bottom: 14px; }
      form.entry-form label { font-size: 11px; flex: 1 1 100%; }
      form.entry-form button[type=submit] { width: 100%; padding: 11px; }
      .when-display { font-size: 15px; }
      .when-quick { gap: 3px; }
      .when-quick button { padding: 5px 7px; font-size: 12px; min-height: 30px; flex: 1 1 auto; }
    }
  </style>
</head>
<body>
  <header>
    <nav id="nav">
      <button data-tab="today" class="active">Today</button>
      <button data-tab="feedings">Feeding</button>
      <button data-tab="diapers">Diaper</button>
      <button data-tab="routines">Routine</button>
      <div class="more-menu">
        <button type="button" id="more-btn" aria-haspopup="true" aria-expanded="false" aria-label="More tabs" title="More">&#8943;</button>
        <div class="more-dropdown" id="more-dropdown" hidden>
          <button data-tab="weights">Weight</button>
          <button data-tab="heights">Height</button>
          <button data-tab="notes">Note</button>
        </div>
      </div>
    </nav>
  </header>

  <main>
    <section id="tab-today" class="tab active">
      <div class="dashboard-grid">
        <div class="card" id="card-today-totals">
          <div class="card-title">Today</div>
          <div class="card-empty">Loading&hellip;</div>
        </div>
        <div class="card" id="card-last-feeding">
          <div class="card-title">Last feeding</div>
          <div class="card-empty">Loading&hellip;</div>
        </div>
        <div class="card" id="card-last-diaper">
          <div class="card-title">Last diaper</div>
          <div class="card-empty">Loading&hellip;</div>
        </div>
        <div class="card" id="card-vitamin-d">
          <div class="card-title">Vitamin D</div>
          <div class="card-empty">Loading&hellip;</div>
        </div>
        <div class="card" id="card-last-tummy">
          <div class="card-title">Last tummy time</div>
          <div class="card-empty">Loading&hellip;</div>
        </div>
        <div class="card" id="card-last-bath">
          <div class="card-title">Last bath</div>
          <div class="card-empty">Loading&hellip;</div>
        </div>
        <div class="card" id="card-last-weight">
          <div class="card-title">Last weight</div>
          <div class="card-empty">Loading&hellip;</div>
        </div>
        <div class="card" id="card-last-height">
          <div class="card-title">Last height</div>
          <div class="card-empty">Loading&hellip;</div>
        </div>
      </div>
    </section>

    <section id="tab-feedings" class="tab">
      <form class="entry-form" data-entity="feedings">
        <label>Amount (ml)
          <input type="number" name="amount_ml" step="0.1" min="0.1" inputmode="decimal" required placeholder="120">
        </label>
        <label>When
${WHEN_BLOCK}
        </label>
        <button type="submit">Add</button>
      </form>
      <div class="week-chart" id="feedings-chart">
        <div class="card-title">This week &mdash; ml per day</div>
        <div class="card-empty">Loading&hellip;</div>
      </div>
      <div class="list" id="list-feedings"><div class="list-loading">Loading...</div></div>
    </section>

    <section id="tab-diapers" class="tab">
      <form class="entry-form" data-entity="diapers">
        <label>Type
          <input type="hidden" name="kind" value="pee">
          <div class="choice-group">
            <button type="button" class="choice-btn active" data-value="pee">Pee</button>
            <button type="button" class="choice-btn" data-value="poop">Poop</button>
            <button type="button" class="choice-btn" data-value="both">Both</button>
          </div>
        </label>
        <label>When
${WHEN_BLOCK}
        </label>
        <button type="submit">Add</button>
      </form>
      <div class="week-chart" id="diapers-chart">
        <div class="card-title">This week &mdash; diapers per day</div>
        <div class="card-empty">Loading&hellip;</div>
      </div>
      <div class="list" id="list-diapers"><div class="list-loading">Loading...</div></div>
    </section>

    <section id="tab-routines" class="tab">
      <form class="entry-form" data-entity="routines">
        <label>Type
          <input type="hidden" name="name" value="Vitamin D">
          <div class="choice-group">
            <button type="button" class="choice-btn active" data-value="Vitamin D">Vitamin D</button>
            <button type="button" class="choice-btn" data-value="Bath">Bath</button>
            <button type="button" class="choice-btn" data-value="Tummy">Tummy</button>
          </div>
        </label>
        <label>When
${WHEN_BLOCK}
        </label>
        <button type="submit">Add</button>
      </form>
      <div class="list" id="list-routines"><div class="list-loading">Loading...</div></div>
    </section>

    <section id="tab-weights" class="tab">
      <form class="entry-form" data-entity="weights">
        <label>Weight (g)
          <input type="number" name="weight_g" step="1" min="1" inputmode="numeric" required placeholder="4250">
        </label>
        <label>When
${WHEN_BLOCK}
        </label>
        <button type="submit">Add</button>
      </form>
      <div class="list" id="list-weights"><div class="list-loading">Loading...</div></div>
    </section>

    <section id="tab-heights" class="tab">
      <form class="entry-form" data-entity="heights">
        <label>Height (cm)
          <input type="number" name="height_cm" step="1" min="1" inputmode="numeric" required placeholder="54">
        </label>
        <label>When
${WHEN_BLOCK}
        </label>
        <button type="submit">Add</button>
      </form>
      <div class="list" id="list-heights"><div class="list-loading">Loading...</div></div>
    </section>

    <section id="tab-notes" class="tab">
      <form class="entry-form" data-entity="notes">
        <label>Note
          <input type="text" name="text" maxlength="2000" required placeholder="first smile, rash, Bath...">
        </label>
        <label>When
${WHEN_BLOCK}
        </label>
        <button type="submit">Add</button>
      </form>
      <div class="list" id="list-notes"><div class="list-loading">Loading...</div></div>
    </section>
  </main>

  <div class="toast" id="toast"></div>

  <script>
    var NUMERIC_FIELDS = { amount_ml: true, weight_g: true, height_cm: true };

    function fmtText(v) { return v == null ? "" : String(v); }

    function fmtKind(v) {
      if (v === "pee") return "Pee";
      if (v === "poop") return "Poop";
      if (v === "both") return "Both";
      return v == null ? "" : String(v);
    }

    var entities = {
      feedings: {
        endpoint: "/api/feedings",
        columns: [
          { key: "ts", label: "When", cls: "ts-col" },
          { key: "amount_ml", label: "Amount", cls: "num-col", fmt: function(v) { return v + " ml"; } }
        ]
      },
      diapers: {
        endpoint: "/api/diapers",
        columns: [
          { key: "ts", label: "When", cls: "ts-col" },
          { key: "kind", label: "Type", fmt: fmtKind }
        ]
      },
      routines: {
        endpoint: "/api/routines",
        columns: [
          { key: "ts", label: "When", cls: "ts-col" },
          { key: "name", label: "Type", fmt: fmtText }
        ]
      },
      notes: {
        endpoint: "/api/notes",
        columns: [
          { key: "ts", label: "When", cls: "ts-col" },
          { key: "text", label: "Note", fmt: fmtText }
        ]
      },
      weights: {
        endpoint: "/api/weights",
        columns: [
          { key: "ts", label: "When", cls: "ts-col" },
          { key: "weight_g", label: "Weight", cls: "num-col", fmt: function(v) { return v + " g"; } }
        ]
      },
      heights: {
        endpoint: "/api/heights",
        columns: [
          { key: "ts", label: "When", cls: "ts-col" },
          { key: "height_cm", label: "Height", cls: "num-col", fmt: function(v) { return v + " cm"; } }
        ]
      }
    };

    function timeAgo(s) {
      if (!s) return "";
      var t = new Date(s).getTime();
      if (isNaN(t)) return String(s);
      var diff = Date.now() - t;
      if (diff < 45 * 1000) return "now";
      if (diff >= 30 * 86400 * 1000) return new Date(s).toLocaleDateString();
      return durationLabel(diff) + " ago";
    }

    function absoluteTs(s) {
      if (!s) return "";
      var d = new Date(s);
      if (isNaN(d.getTime())) return String(s);
      return d.toLocaleString();
    }

    function tableTs(s) {
      if (!s) return "";
      var d = new Date(s);
      if (isNaN(d.getTime())) return String(s);
      var pad = function(n) { return n < 10 ? "0" + n : String(n); };
      var time = pad(d.getHours()) + ":" + pad(d.getMinutes());
      var now = new Date();
      if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
        return time;
      }
      var datePart = pad(d.getDate()) + "/" + pad(d.getMonth() + 1);
      if (d.getFullYear() !== now.getFullYear()) datePart += "/" + d.getFullYear();
      return datePart + " " + time;
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function startOfDay() {
      var d = new Date();
      d.setHours(0, 0, 0, 0);
      return d;
    }

    function toLocalDatetimeString(d) {
      function pad(n) { return n < 10 ? "0" + n : String(n); }
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
        "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }

    var toastEl = document.getElementById("toast");
    var toastTimer = null;
    function toast(msg, isError) {
      toastEl.textContent = msg;
      toastEl.className = "toast show" + (isError ? " error" : "");
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function() {
        toastEl.className = "toast" + (isError ? " error" : "");
      }, 2400);
    }

    function gotoLogin() {
      location.href = "/app/login?next=" + encodeURIComponent(location.pathname);
    }

    async function fetchJson(url) {
      var res = await fetch(url, { headers: { Accept: "application/json" } });
      if (res.status === 401) { gotoLogin(); throw new Error("Unauthorized"); }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    }

    async function postJson(url, body) {
      var res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body)
      });
      if (res.status === 401) { gotoLogin(); throw new Error("Unauthorized"); }
      if (!res.ok) {
        var msg = "";
        try { msg = await res.text(); } catch (_) {}
        throw new Error(msg || ("HTTP " + res.status));
      }
      return await res.json();
    }

    async function loadList(entity) {
      if (entity === "feedings" || entity === "diapers") return loadWeek(entity);
      var cfg = entities[entity];
      var container = document.getElementById("list-" + entity);
      try {
        var data = await fetchJson(cfg.endpoint);
        renderList(entity, data.items || []);
      } catch (err) {
        if (err.message === "Unauthorized") return;
        container.innerHTML = '<div class="list-empty">Error loading: ' + escapeHtml(err.message) + "</div>";
      }
    }

    // --- Weekly charts (Mon-Sun) with prev/next nav + day-filtering of the list ---
    function startOfWeek() {
      var d = startOfDay();
      var dow = (d.getDay() + 6) % 7; // 0 = Monday
      d.setDate(d.getDate() - dow);
      return d;
    }

    var WEEK_DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

    var charts = {
      feedings: { elId: "feedings-chart", endpoint: "/api/feedings", renderBars: renderFeedingBars,
        weekStart: startOfWeek(), selectedDay: null, items: [] },
      diapers: { elId: "diapers-chart", endpoint: "/api/diapers", renderBars: renderDiaperBars,
        weekStart: startOfWeek(), selectedDay: null, items: [] }
    };

    function resetChartWeek(key) {
      charts[key].weekStart = startOfWeek();
      charts[key].selectedDay = null;
    }

    function fmtDayMonth(d) {
      var pad = function(n) { return n < 10 ? "0" + n : String(n); };
      return pad(d.getDate()) + "/" + pad(d.getMonth() + 1);
    }

    function dayIndexOf(ts, weekStart) {
      var d = new Date(ts);
      if (isNaN(d.getTime())) return -1;
      return Math.floor((d.getTime() - weekStart.getTime()) / 86400000);
    }

    async function loadWeek(key) {
      var c = charts[key];
      var el = document.getElementById(c.elId);
      if (!el) return;
      var weekEnd = new Date(c.weekStart.getTime());
      weekEnd.setDate(weekEnd.getDate() + 7);
      var qs = "since=" + encodeURIComponent(c.weekStart.toISOString()) +
        "&until=" + encodeURIComponent(weekEnd.toISOString()) + "&limit=500";
      try {
        var data = await fetchJson(c.endpoint + "?" + qs);
        c.items = data.items || [];
        renderWeek(key);
      } catch (err) {
        if (err.message === "Unauthorized") return;
        el.innerHTML = '<div class="card-empty">Error loading chart: ' + escapeHtml(err.message) + '</div>';
      }
    }

    function renderWeek(key) {
      var c = charts[key];
      var el = document.getElementById(c.elId);
      var isCurrent = c.weekStart.getTime() === startOfWeek().getTime();
      var weekEnd = new Date(c.weekStart.getTime());
      weekEnd.setDate(weekEnd.getDate() + 6);
      var title = (isCurrent ? "This week" : "Week") + " &mdash; " +
        escapeHtml(fmtDayMonth(c.weekStart) + " – " + fmtDayMonth(weekEnd));
      el.innerHTML =
        '<div class="chart-head">' +
          '<button type="button" class="chart-nav" data-week="-1" aria-label="Previous week">&#9664;</button>' +
          '<div class="card-title chart-title">' + title + '</div>' +
          '<button type="button" class="chart-nav" data-week="1" aria-label="Next week"' + (isCurrent ? " disabled" : "") + '>&#9654;</button>' +
        '</div>' +
        c.renderBars(c);
      renderWeekList(key);
    }

    function renderWeekList(key) {
      var c = charts[key];
      var items = c.items;
      if (c.selectedDay !== null) {
        var dayStart = new Date(c.weekStart.getTime());
        dayStart.setDate(dayStart.getDate() + c.selectedDay);
        var dayEnd = dayStart.getTime() + 86400000;
        items = items.filter(function(it) {
          var t = new Date(it.ts).getTime();
          return t >= dayStart.getTime() && t < dayEnd;
        });
      }
      renderList(key, items);
    }

    // Build one clickable day column; inner is the bar(s) markup for the column.
    function dayColumn(c, b, inner) {
      var cls = "chart-bar";
      if (b === dayIndexOf(startOfDay().toISOString(), c.weekStart)) cls += " today";
      if (b === c.selectedDay) cls += " selected";
      return '<div class="' + cls + '" data-day="' + b + '" role="button" tabindex="0" aria-pressed="' + (b === c.selectedDay) + '">' +
        inner +
        '<div class="chart-bar-label">' + WEEK_DAY_LABELS[b] + '</div>' +
      '</div>';
    }

    function renderFeedingBars(c) {
      var totals = [0, 0, 0, 0, 0, 0, 0];
      for (var i = 0; i < c.items.length; i++) {
        var idx = dayIndexOf(c.items[i].ts, c.weekStart);
        if (idx < 0 || idx > 6) continue;
        var n = Number(c.items[i].amount_ml);
        if (isFinite(n)) totals[idx] += n;
      }
      var max = 0;
      for (var m = 0; m < 7; m++) if (totals[m] > max) max = totals[m];
      var bars = "";
      for (var b = 0; b < 7; b++) {
        var pct = max > 0 ? Math.round((totals[b] / max) * 100) : 0;
        var ml = totals[b];
        var mlStr = ml % 1 === 0 ? String(ml) : ml.toFixed(1);
        bars += dayColumn(c, b,
          '<div class="chart-bar-val">' + (ml > 0 ? escapeHtml(mlStr) : "") + '</div>' +
          '<div class="chart-bar-fill" style="height:' + pct + '%"></div>');
      }
      return '<div class="chart-bars">' + bars + '</div>';
    }

    function renderDiaperBars(c) {
      var pees = [0, 0, 0, 0, 0, 0, 0];
      var poops = [0, 0, 0, 0, 0, 0, 0];
      for (var i = 0; i < c.items.length; i++) {
        var idx = dayIndexOf(c.items[i].ts, c.weekStart);
        if (idx < 0 || idx > 6) continue;
        var k = c.items[i].kind;
        if (k === "pee" || k === "both") pees[idx]++;
        if (k === "poop" || k === "both") poops[idx]++;
      }
      var max = 0;
      for (var m = 0; m < 7; m++) {
        if (pees[m] > max) max = pees[m];
        if (poops[m] > max) max = poops[m];
      }
      function subBar(count, kindCls) {
        var pct = max > 0 ? Math.round((count / max) * 100) : 0;
        return '<div class="chart-sub">' +
          '<div class="chart-bar-val">' + (count > 0 ? count : "") + '</div>' +
          '<div class="chart-bar-fill ' + kindCls + '" style="height:' + pct + '%"></div>' +
        '</div>';
      }
      var bars = "";
      for (var b = 0; b < 7; b++) {
        bars += dayColumn(c, b,
          '<div class="chart-pair">' + subBar(pees[b], "pee") + subBar(poops[b], "poop") + '</div>');
      }
      var legend = '<div class="chart-legend">' +
        '<span><i class="pee"></i>Pee</span><span><i class="poop"></i>Poop</span>' +
      '</div>';
      return legend + '<div class="chart-bars">' + bars + '</div>';
    }

    // Chart navigation (prev/next week) and day selection — shared by all charts.
    function bindChart(key) {
      var el = document.getElementById(charts[key].elId);
      if (!el) return;
      el.addEventListener("click", function(e) { handleChartActivate(key, e.target); });
      el.addEventListener("keydown", function(e) {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
          var bar = e.target && e.target.closest ? e.target.closest(".chart-bar") : null;
          if (bar) { e.preventDefault(); handleChartActivate(key, bar); }
        }
      });
    }

    function handleChartActivate(key, target) {
      if (!target || !target.closest) return;
      var c = charts[key];
      var nav = target.closest(".chart-nav");
      if (nav && !nav.disabled) {
        var delta = parseInt(nav.getAttribute("data-week"), 10);
        c.weekStart = new Date(c.weekStart.getTime());
        c.weekStart.setDate(c.weekStart.getDate() + delta * 7);
        c.selectedDay = null;
        loadWeek(key);
        return;
      }
      var bar = target.closest(".chart-bar");
      if (bar) {
        var day = parseInt(bar.getAttribute("data-day"), 10);
        c.selectedDay = (c.selectedDay === day) ? null : day; // toggle
        renderWeek(key); // re-render from cached data, no refetch
      }
    }

    bindChart("feedings");
    bindChart("diapers");

    function renderList(entity, items) {
      var cfg = entities[entity];
      var container = document.getElementById("list-" + entity);
      if (!items.length) {
        container.innerHTML = '<div class="list-empty">No entries yet.</div>';
        return;
      }
      var head = "";
      for (var i = 0; i < cfg.columns.length; i++) {
        var c = cfg.columns[i];
        head += "<th" + (c.cls ? ' class="' + c.cls + '"' : "") + ">" + escapeHtml(c.label) + "</th>";
      }
      head += '<th class="actions-col"></th>';

      var body = "";
      for (var j = 0; j < items.length; j++) {
        var item = items[j];
        var row = "";
        for (var k = 0; k < cfg.columns.length; k++) {
          var col = cfg.columns[k];
          var val = item[col.key];
          if (col.cls === "ts-col") {
            row += '<td class="ts-col">' + escapeHtml(tableTs(val)) + '</td>';
          } else {
            var rendered = col.fmt ? col.fmt(val) : (val == null ? "" : val);
            row += "<td" + (col.cls ? ' class="' + col.cls + '"' : "") + ">" + escapeHtml(rendered) + "</td>";
          }
        }
        row += '<td class="actions-col"><button class="delete-btn" data-id="' + item.id + '" data-entity="' + entity + '">Delete</button></td>';
        body += "<tr>" + row + "</tr>";
      }
      container.innerHTML = "<table><thead><tr>" + head + "</tr></thead><tbody>" + body + "</tbody></table>";
    }

    // --- Dashboard ---
    async function loadDashboard() {
      var sinceToday = "since=" + encodeURIComponent(startOfDay().toISOString());
      try {
        var results = await Promise.all([
          fetchJson("/api/feedings?limit=1"),
          fetchJson("/api/feedings?" + sinceToday),
          fetchJson("/api/diapers?limit=1"),
          fetchJson("/api/diapers?" + sinceToday),
          fetchJson("/api/routines?name=" + encodeURIComponent("Vitamin D") + "&limit=1"),
          fetchJson("/api/routines?name=" + encodeURIComponent("Bath") + "&limit=1"),
          fetchJson("/api/routines?name=" + encodeURIComponent("Tummy") + "&limit=1"),
          fetchJson("/api/weights?limit=1"),
          fetchJson("/api/heights?limit=1")
        ]);
        renderLastFeeding((results[0].items || [])[0]);
        renderLastDiaper((results[2].items || [])[0]);
        renderTodayTotals(results[1].items || [], results[3].items || []);
        renderVitaminD((results[4].items || [])[0]);
        renderLastBath((results[5].items || [])[0]);
        renderLastTummy((results[6].items || [])[0]);
        renderLastMeasurement("card-last-weight", "Last weight", (results[7].items || [])[0], "weight_g", "g");
        renderLastMeasurement("card-last-height", "Last height", (results[8].items || [])[0], "height_cm", "cm");
      } catch (err) {
        if (err.message !== "Unauthorized") toast("Error loading dashboard: " + err.message, true);
      }
    }

    function renderVitaminD(item) {
      var el = document.getElementById("card-vitamin-d");
      var head = '<div class="card-title">Vitamin D</div>';
      var isToday = item && new Date(item.ts).getTime() >= startOfDay().getTime();
      var body = isToday
        ? '<div class="card-main">' + escapeHtml(timeAgo(item.ts)) + '</div>' +
          '<div class="card-sub" title="' + escapeHtml(absoluteTs(item.ts)) + '">' + escapeHtml(formatWhenAbs(new Date(item.ts))) + '</div>'
        : '<div class="card-empty">Not given today yet</div>';
      var actions = '<div class="quick-row">' +
        '<button class="quick-btn" data-quick="routine" data-name="Vitamin D">+ Vitamin D</button>' +
      '</div>';
      el.innerHTML = head + body + actions;
    }

    function renderLastBath(item) {
      var el = document.getElementById("card-last-bath");
      var head = '<div class="card-title">Last bath</div>';
      var body = item
        ? '<div class="card-main">' + escapeHtml(timeAgo(item.ts)) + '</div>' +
          '<div class="card-sub" title="' + escapeHtml(absoluteTs(item.ts)) + '">' + escapeHtml(formatWhenAbs(new Date(item.ts))) + '</div>'
        : '<div class="card-empty">No baths yet</div>';
      var actions = '<div class="quick-row">' +
        '<button class="quick-btn" data-quick="routine" data-name="Bath">+ Bath</button>' +
      '</div>';
      el.innerHTML = head + body + actions;
    }

    function renderLastTummy(item) {
      var el = document.getElementById("card-last-tummy");
      var head = '<div class="card-title">Last tummy time</div>';
      var body = item
        ? '<div class="card-main">' + escapeHtml(timeAgo(item.ts)) + '</div>' +
          '<div class="card-sub" title="' + escapeHtml(absoluteTs(item.ts)) + '">' + escapeHtml(formatWhenAbs(new Date(item.ts))) + '</div>'
        : '<div class="card-empty">No tummy time yet</div>';
      var actions = '<div class="quick-row">' +
        '<button class="quick-btn" data-quick="routine" data-name="Tummy">+ Tummy</button>' +
      '</div>';
      el.innerHTML = head + body + actions;
    }

    var FEEDING_SHORTCUTS = [30, 60, 90];

    function feedingShortcutsHtml() {
      var html = '<div class="quick-row">';
      for (var i = 0; i < FEEDING_SHORTCUTS.length; i++) {
        var amt = FEEDING_SHORTCUTS[i];
        html += '<button class="quick-btn" data-quick="feeding" data-amount="' + amt + '">+ ' + amt + ' ml</button>';
      }
      html += '</div>';
      return html;
    }

    function renderLastFeeding(item) {
      var el = document.getElementById("card-last-feeding");
      if (!item) {
        el.innerHTML = '<div class="card-title">Last feeding</div>' +
          '<div class="card-empty">No feedings yet</div>' +
          feedingShortcutsHtml();
        return;
      }
      var amt = item.amount_ml;
      var sub = escapeHtml(timeAgo(item.ts));
      el.innerHTML = '<div class="card-title">Last feeding</div>' +
        '<div class="card-main">' + escapeHtml(amt + " ml") + '</div>' +
        '<div class="card-sub" title="' + escapeHtml(absoluteTs(item.ts)) + '">' + sub + '</div>' +
        feedingShortcutsHtml();
    }

    function renderLastDiaper(item) {
      var el = document.getElementById("card-last-diaper");
      var head = '<div class="card-title">Last diaper</div>';
      var body = item
        ? '<div class="card-main">' + escapeHtml(fmtKind(item.kind)) + '</div>' +
          '<div class="card-sub" title="' + escapeHtml(absoluteTs(item.ts)) + '">' + escapeHtml(timeAgo(item.ts)) + '</div>'
        : '<div class="card-empty">No diapers yet</div>';
      var actions = '<div class="quick-row">' +
        '<button class="quick-btn" data-quick="diaper" data-kind="pee">+ Pee</button>' +
        '<button class="quick-btn" data-quick="diaper" data-kind="poop">+ Poop</button>' +
        '<button class="quick-btn" data-quick="diaper" data-kind="both">+ Both</button>' +
      '</div>';
      el.innerHTML = head + body + actions;
    }

    function renderTodayTotals(todayFeedings, todayDiapers) {
      var el = document.getElementById("card-today-totals");
      var head = '<div class="card-title">Today</div>';
      if (todayFeedings.length === 0 && todayDiapers.length === 0) {
        el.innerHTML = head + '<div class="card-empty">Nothing recorded today</div>';
        return;
      }
      var totalMl = 0;
      for (var i = 0; i < todayFeedings.length; i++) {
        var n = Number(todayFeedings[i].amount_ml);
        if (isFinite(n)) totalMl += n;
      }
      var pee = 0, poop = 0, both = 0;
      for (var j = 0; j < todayDiapers.length; j++) {
        var k = todayDiapers[j].kind;
        if (k === "pee") pee++;
        else if (k === "poop") poop++;
        else if (k === "both") both++;
      }
      var mlStr = totalMl % 1 === 0 ? totalMl + " ml" : totalMl.toFixed(1) + " ml";
      var items = [
        { num: todayFeedings.length, label: "Feedings" },
        { num: mlStr, label: "Total" },
        { num: pee, label: "Pee" },
        { num: poop, label: "Poop" }
      ];
      if (both > 0) items.push({ num: both, label: "Both" });
      var rows = "";
      for (var x = 0; x < items.length; x++) {
        rows += '<div class="totals-item"><div class="totals-num">' + escapeHtml(String(items[x].num)) + '</div><div class="totals-label">' + escapeHtml(items[x].label) + '</div></div>';
      }
      el.innerHTML = head + '<div class="totals-row">' + rows + '</div>';
    }

    function renderLastMeasurement(cardId, title, item, valueKey, unit) {
      var el = document.getElementById(cardId);
      var head = '<div class="card-title">' + escapeHtml(title) + '</div>';
      if (!item) {
        el.innerHTML = head + '<div class="card-empty">No measurements</div>';
        return;
      }
      el.innerHTML = head +
        '<div class="card-main">' + escapeHtml(item[valueKey] + " " + unit) + '</div>' +
        '<div class="card-sub" title="' + escapeHtml(absoluteTs(item.ts)) + '">' + escapeHtml(timeAgo(item.ts)) + '</div>';
    }

    var MORE_TABS = { weights: true, heights: true, notes: true };

    function closeMoreDropdown() {
      var d = document.getElementById("more-dropdown");
      var b = document.getElementById("more-btn");
      if (d) d.hidden = true;
      if (b) b.setAttribute("aria-expanded", "false");
    }

    function showTab(name) {
      var navBtns = document.querySelectorAll("#nav [data-tab]");
      for (var i = 0; i < navBtns.length; i++) {
        navBtns[i].classList.toggle("active", navBtns[i].getAttribute("data-tab") === name);
      }
      var moreBtn = document.getElementById("more-btn");
      if (moreBtn) moreBtn.classList.toggle("active", !!MORE_TABS[name]);
      var tabs = document.querySelectorAll(".tab");
      for (var j = 0; j < tabs.length; j++) {
        tabs[j].classList.toggle("active", tabs[j].id === "tab-" + name);
      }
      closeMoreDropdown();
      try { history.replaceState(null, "", "#" + name); } catch (_) {}
      if (name === "today") {
        loadDashboard();
      } else if (entities[name]) {
        if (charts[name]) resetChartWeek(name);
        loadList(name);
      }
    }

    document.getElementById("nav").addEventListener("click", function(e) {
      var t = e.target;
      if (!t) return;
      if (t.id === "more-btn") {
        e.stopPropagation();
        var d = document.getElementById("more-dropdown");
        var willOpen = d.hidden;
        d.hidden = !willOpen;
        t.setAttribute("aria-expanded", willOpen ? "true" : "false");
        return;
      }
      if (t.tagName === "BUTTON" && t.getAttribute("data-tab")) {
        showTab(t.getAttribute("data-tab"));
      }
    });

    document.addEventListener("click", function(e) {
      var d = document.getElementById("more-dropdown");
      if (!d || d.hidden) return;
      var menu = e.target && e.target.closest ? e.target.closest(".more-menu") : null;
      if (!menu) closeMoreDropdown();
    });

    // --- "When" field: cumulative steppers + read-only display label ---
    function durationLabel(absMs) {
      var mins = Math.round(absMs / 60000);
      if (mins < 60) return mins + " min";
      var hrs = Math.floor(mins / 60);
      var rem = mins % 60;
      if (hrs < 24) return rem ? (hrs + "h " + rem + "m") : (hrs + "h");
      var days = Math.floor(hrs / 24);
      return days + (days === 1 ? " day" : " days");
    }

    function formatTimeOfDay(d) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    }

    function formatWhenAbs(d) {
      var now = new Date();
      if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
        return formatTimeOfDay(d);
      }
      var yest = new Date(now);
      yest.setDate(yest.getDate() - 1);
      if (d.getFullYear() === yest.getFullYear() && d.getMonth() === yest.getMonth() && d.getDate() === yest.getDate()) {
        return "yesterday " + formatTimeOfDay(d);
      }
      return d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + formatTimeOfDay(d);
    }

    function updateWhenDisplay(input) {
      var label = input.closest("label");
      var display = label ? label.querySelector("[data-when-display]") : null;
      if (!display) return;
      if (!input.value) { display.textContent = "Now"; return; }
      var d = new Date(input.value);
      if (isNaN(d.getTime())) { display.textContent = ""; return; }
      var diff = d.getTime() - Date.now();
      if (Math.abs(diff) < 30 * 1000) { display.textContent = "Now"; return; }
      var abs = formatWhenAbs(d);
      if (diff < 0) display.textContent = durationLabel(-diff) + " ago · " + abs;
      else display.textContent = "In " + durationLabel(diff) + " · " + abs;
    }

    function stepWhen(input, deltaMin) {
      var base = input.value ? new Date(input.value) : new Date();
      if (isNaN(base.getTime())) base = new Date();
      var next = new Date(base.getTime() + deltaMin * 60 * 1000);
      if (Math.abs(next.getTime() - Date.now()) < 30 * 1000) {
        input.value = "";
      } else {
        input.value = toLocalDatetimeString(next);
      }
      updateWhenDisplay(input);
    }

    document.addEventListener("click", function(e) {
      var t = e.target;
      if (!t || t.tagName !== "BUTTON") return;
      if (!t.parentNode || !t.parentNode.classList || !t.parentNode.classList.contains("when-quick")) return;
      e.preventDefault();
      var label = t.closest("label");
      var input = label ? label.querySelector('input[name="when"]') : null;
      if (!input) return;
      if (t.hasAttribute("data-now")) {
        input.value = "";
        updateWhenDisplay(input);
        return;
      }
      var step = parseInt(t.getAttribute("data-step"), 10);
      if (isFinite(step)) stepWhen(input, step);
    });

    var whenInputs = document.querySelectorAll('input[name="when"]');
    for (var wi = 0; wi < whenInputs.length; wi++) {
      updateWhenDisplay(whenInputs[wi]);
    }

    setInterval(function() {
      for (var i = 0; i < whenInputs.length; i++) updateWhenDisplay(whenInputs[i]);
    }, 30 * 1000);

    // --- Choice button groups (segmented selectors backed by a hidden input) ---
    document.addEventListener("click", function(e) {
      var t = e.target;
      if (!t || !t.classList || !t.classList.contains("choice-btn")) return;
      e.preventDefault();
      var group = t.parentElement;
      if (!group || !group.classList.contains("choice-group")) return;
      var label = t.closest("label");
      var hidden = label ? label.querySelector('input[type="hidden"]') : null;
      if (!hidden) return;
      hidden.value = t.getAttribute("data-value") || "";
      var btns = group.querySelectorAll(".choice-btn");
      for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("active", btns[i] === t);
    });

    function resetChoiceGroups(form) {
      var groups = form.querySelectorAll(".choice-group");
      for (var g = 0; g < groups.length; g++) {
        var grp = groups[g];
        var grpLabel = grp.closest("label");
        var hidden = grpLabel ? grpLabel.querySelector('input[type="hidden"]') : null;
        var defaultVal = hidden ? hidden.value : null;
        var btns = grp.querySelectorAll(".choice-btn");
        for (var b = 0; b < btns.length; b++) {
          btns[b].classList.toggle("active", btns[b].getAttribute("data-value") === defaultVal);
        }
      }
    }

    var entryForms = document.querySelectorAll("form.entry-form");
    for (var ef = 0; ef < entryForms.length; ef++) {
      entryForms[ef].addEventListener("reset", function(e) {
        var form = e.currentTarget;
        setTimeout(function() {
          var inp = form.querySelector('input[name="when"]');
          if (inp) updateWhenDisplay(inp);
          resetChoiceGroups(form);
        }, 0);
      });
    }

    // --- Entry forms ---
    var forms = document.querySelectorAll("form.entry-form");
    for (var f = 0; f < forms.length; f++) {
      forms[f].addEventListener("submit", async function(e) {
        e.preventDefault();
        var form = e.currentTarget;
        var entity = form.getAttribute("data-entity");
        var fd = new FormData(form);
        var body = {};
        fd.forEach(function(v, k) {
          var s = String(v).trim();
          if (!s) return;
          if (k === "when") {
            var d = new Date(s);
            if (!isNaN(d.getTime())) body[k] = d.toISOString();
          } else if (NUMERIC_FIELDS[k]) {
            var n = parseFloat(s);
            if (!isNaN(n)) body[k] = n;
          } else {
            body[k] = s;
          }
        });
        var submitBtn = form.querySelector('button[type=submit]');
        submitBtn.disabled = true;
        try {
          await postJson(entities[entity].endpoint, body);
          form.reset();
          toast("Saved");
          if (charts[entity]) resetChartWeek(entity);
          loadList(entity);
        } catch (err) {
          if (err.message !== "Unauthorized") toast("Error: " + err.message, true);
        } finally {
          submitBtn.disabled = false;
        }
      });
    }

    // --- Dashboard quick-add buttons ---
    document.addEventListener("click", async function(e) {
      var t = e.target;
      if (!t || t.tagName !== "BUTTON" || t.disabled) return;
      var which = t.getAttribute("data-quick");
      if (which === "feeding") {
        var amt = parseFloat(t.getAttribute("data-amount"));
        if (!isFinite(amt) || amt <= 0) return;
        quickPost(t, "/api/feedings", { amount_ml: amt }, "Recorded: " + amt + " ml");
      } else if (which === "diaper") {
        var kind = t.getAttribute("data-kind");
        if (!kind) return;
        quickPost(t, "/api/diapers", { kind: kind }, "Diaper: " + fmtKind(kind));
      } else if (which === "routine") {
        var routineName = t.getAttribute("data-name");
        if (!routineName) return;
        quickPost(t, "/api/routines", { name: routineName }, "Routine: " + routineName);
      }
    });

    async function quickPost(btn, endpoint, body, doneMsg) {
      btn.disabled = true;
      try {
        await postJson(endpoint, body);
        toast(doneMsg);
        loadDashboard();
      } catch (err) {
        if (err.message !== "Unauthorized") toast("Error: " + err.message, true);
      } finally {
        btn.disabled = false;
      }
    }

    // --- Inline delete confirmation (two-tap) ---
    function disarmAllDeletes(except) {
      var pending = document.querySelectorAll(".delete-btn.pending");
      for (var i = 0; i < pending.length; i++) {
        if (pending[i] === except) continue;
        pending[i].classList.remove("pending");
        pending[i].textContent = "Delete";
      }
    }

    document.addEventListener("click", async function(e) {
      var t = e.target;
      if (!t || !t.classList) return;
      if (!t.classList.contains("delete-btn")) {
        disarmAllDeletes(null);
        return;
      }
      if (!t.classList.contains("pending")) {
        disarmAllDeletes(t);
        t.classList.add("pending");
        t.textContent = "Confirm?";
        setTimeout(function() {
          if (t.classList.contains("pending")) {
            t.classList.remove("pending");
            t.textContent = "Delete";
          }
        }, 4000);
        return;
      }
      var id = t.getAttribute("data-id");
      var entity = t.getAttribute("data-entity");
      t.disabled = true;
      try {
        var res = await fetch(entities[entity].endpoint + "/" + encodeURIComponent(id), { method: "DELETE" });
        if (res.status === 401) { gotoLogin(); return; }
        if (!res.ok) { toast("Delete error", true); return; }
        toast("Deleted");
        loadList(entity);
      } catch (err) {
        toast("Network error: " + err.message, true);
      } finally {
        t.disabled = false;
      }
    });

    // Restore the tab from the URL hash so a refresh keeps the selected tab.
    function tabFromHash() {
      var h = (location.hash || "").replace(/^#/, "");
      return (h === "today" || entities[h]) ? h : "today";
    }
    window.addEventListener("hashchange", function() { showTab(tabFromHash()); });
    showTab(tabFromHash());

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
      });
    }
  </script>
</body>
</html>`;

async function handleAppHome(request: Request, env: Env): Promise<Response> {
  if (!(await isWebAuthorized(request, env))) {
    return new Response(null, {
      status: 303,
      headers: { Location: "/app/login?next=/app" },
    });
  }
  return new Response(APP_HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// -----------------------------------------------------------------------------
// JSON API for the web app. All routes require a valid session cookie.
// -----------------------------------------------------------------------------

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

const FeedingCreateSchema = z.object({
  amount_ml: z.number().positive(),
  when: z.string().datetime().optional(),
});

const DiaperCreateSchema = z.object({
  kind: z.enum(["pee", "poop", "both"]),
  when: z.string().datetime().optional(),
});

const RoutineCreateSchema = z.object({
  name: z.string().min(1).max(100),
  when: z.string().datetime().optional(),
});

const NoteCreateSchema = z.object({
  text: z.string().min(1).max(2000),
  when: z.string().datetime().optional(),
});

const WeightCreateSchema = z.object({
  weight_g: z.number().int().positive(),
  when: z.string().datetime().optional(),
});

const HeightCreateSchema = z.object({
  height_cm: z.number().int().positive(),
  when: z.string().datetime().optional(),
});

async function listRows<T>(
  db: D1Database,
  sql: string,
  params: (string | number)[]
): Promise<T[]> {
  const { results } = await db.prepare(sql).bind(...params).all<T>();
  return results;
}

async function deleteRow(
  db: D1Database,
  table: string,
  id: number
): Promise<boolean> {
  const res = await db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

async function apiFeedings(
  method: string,
  url: URL,
  idStr: string | undefined,
  request: Request,
  env: Env
): Promise<Response> {
  if (method === "GET" && !idStr) {
    const since = url.searchParams.get("since");
    const until = url.searchParams.get("until");
    const limit = parseLimit(url.searchParams.get("limit"));
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (since) { clauses.push("ts >= ?"); params.push(since); }
    if (until) { clauses.push("ts < ?"); params.push(until); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    const items = await listRows<FeedingRow>(
      env.DB,
      `SELECT id, ts, amount_ml FROM feedings ${where} ORDER BY ts DESC LIMIT ?`,
      params
    );
    return jsonOk({ items });
  }
  if (method === "POST" && !idStr) {
    const parsed = await readBody(request, FeedingCreateSchema);
    if (!parsed.ok) return jsonError(400, parsed.error);
    const ts = parsed.value.when ?? new Date().toISOString();
    const row = await env.DB
      .prepare("INSERT INTO feedings (ts, amount_ml) VALUES (?, ?) RETURNING id, ts, amount_ml")
      .bind(ts, parsed.value.amount_ml)
      .first<FeedingRow>();
    return jsonOk(row, 201);
  }
  if (method === "DELETE" && idStr) {
    const id = parseIdParam(idStr);
    if (id === null) return jsonError(400, "Invalid id.");
    const ok = await deleteRow(env.DB, "feedings", id);
    if (!ok) return jsonError(404, "Not found.");
    return jsonOk({ deleted: id });
  }
  return jsonError(405, "Method not allowed.");
}

async function apiDiapers(
  method: string,
  url: URL,
  idStr: string | undefined,
  request: Request,
  env: Env
): Promise<Response> {
  if (method === "GET" && !idStr) {
    const since = url.searchParams.get("since");
    const until = url.searchParams.get("until");
    const kind = url.searchParams.get("kind");
    const limit = parseLimit(url.searchParams.get("limit"));
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (since) { clauses.push("ts >= ?"); params.push(since); }
    if (until) { clauses.push("ts < ?"); params.push(until); }
    if (kind && ["pee", "poop", "both"].includes(kind)) { clauses.push("kind = ?"); params.push(kind); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    const items = await listRows<DiaperRow>(
      env.DB,
      `SELECT id, ts, kind FROM diapers ${where} ORDER BY ts DESC LIMIT ?`,
      params
    );
    return jsonOk({ items });
  }
  if (method === "POST" && !idStr) {
    const parsed = await readBody(request, DiaperCreateSchema);
    if (!parsed.ok) return jsonError(400, parsed.error);
    const ts = parsed.value.when ?? new Date().toISOString();
    const row = await env.DB
      .prepare("INSERT INTO diapers (ts, kind) VALUES (?, ?) RETURNING id, ts, kind")
      .bind(ts, parsed.value.kind)
      .first<DiaperRow>();
    return jsonOk(row, 201);
  }
  if (method === "DELETE" && idStr) {
    const id = parseIdParam(idStr);
    if (id === null) return jsonError(400, "Invalid id.");
    const ok = await deleteRow(env.DB, "diapers", id);
    if (!ok) return jsonError(404, "Not found.");
    return jsonOk({ deleted: id });
  }
  return jsonError(405, "Method not allowed.");
}

async function apiRoutines(
  method: string,
  url: URL,
  idStr: string | undefined,
  request: Request,
  env: Env
): Promise<Response> {
  if (method === "GET" && !idStr) {
    const since = url.searchParams.get("since");
    const until = url.searchParams.get("until");
    const name = url.searchParams.get("name");
    const limit = parseLimit(url.searchParams.get("limit"));
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (since) { clauses.push("ts >= ?"); params.push(since); }
    if (until) { clauses.push("ts < ?"); params.push(until); }
    if (name) { clauses.push("LOWER(name) LIKE ?"); params.push(`%${name.toLowerCase()}%`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    const items = await listRows<RoutineRow>(
      env.DB,
      `SELECT id, ts, name FROM routines ${where} ORDER BY ts DESC LIMIT ?`,
      params
    );
    return jsonOk({ items });
  }
  if (method === "POST" && !idStr) {
    const parsed = await readBody(request, RoutineCreateSchema);
    if (!parsed.ok) return jsonError(400, parsed.error);
    const ts = parsed.value.when ?? new Date().toISOString();
    const row = await env.DB
      .prepare("INSERT INTO routines (ts, name) VALUES (?, ?) RETURNING id, ts, name")
      .bind(ts, parsed.value.name)
      .first<RoutineRow>();
    return jsonOk(row, 201);
  }
  if (method === "DELETE" && idStr) {
    const id = parseIdParam(idStr);
    if (id === null) return jsonError(400, "Invalid id.");
    const ok = await deleteRow(env.DB, "routines", id);
    if (!ok) return jsonError(404, "Not found.");
    return jsonOk({ deleted: id });
  }
  return jsonError(405, "Method not allowed.");
}

async function apiNotes(
  method: string,
  url: URL,
  idStr: string | undefined,
  request: Request,
  env: Env
): Promise<Response> {
  if (method === "GET" && !idStr) {
    const since = url.searchParams.get("since");
    const until = url.searchParams.get("until");
    const search = url.searchParams.get("search");
    const limit = parseLimit(url.searchParams.get("limit"));
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (since) { clauses.push("ts >= ?"); params.push(since); }
    if (until) { clauses.push("ts < ?"); params.push(until); }
    if (search) { clauses.push("LOWER(text) LIKE ?"); params.push(`%${search.toLowerCase()}%`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    const items = await listRows<NoteRow>(
      env.DB,
      `SELECT id, ts, text FROM notes ${where} ORDER BY ts DESC LIMIT ?`,
      params
    );
    return jsonOk({ items });
  }
  if (method === "POST" && !idStr) {
    const parsed = await readBody(request, NoteCreateSchema);
    if (!parsed.ok) return jsonError(400, parsed.error);
    const ts = parsed.value.when ?? new Date().toISOString();
    const row = await env.DB
      .prepare("INSERT INTO notes (ts, text) VALUES (?, ?) RETURNING id, ts, text")
      .bind(ts, parsed.value.text)
      .first<NoteRow>();
    return jsonOk(row, 201);
  }
  if (method === "DELETE" && idStr) {
    const id = parseIdParam(idStr);
    if (id === null) return jsonError(400, "Invalid id.");
    const ok = await deleteRow(env.DB, "notes", id);
    if (!ok) return jsonError(404, "Not found.");
    return jsonOk({ deleted: id });
  }
  return jsonError(405, "Method not allowed.");
}

async function apiWeights(
  method: string,
  url: URL,
  idStr: string | undefined,
  request: Request,
  env: Env
): Promise<Response> {
  if (method === "GET" && !idStr) {
    const since = url.searchParams.get("since");
    const until = url.searchParams.get("until");
    const limit = parseLimit(url.searchParams.get("limit"));
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (since) { clauses.push("ts >= ?"); params.push(since); }
    if (until) { clauses.push("ts < ?"); params.push(until); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    const items = await listRows<WeightRow>(
      env.DB,
      `SELECT id, ts, weight_g FROM weights ${where} ORDER BY ts DESC LIMIT ?`,
      params
    );
    return jsonOk({ items });
  }
  if (method === "POST" && !idStr) {
    const parsed = await readBody(request, WeightCreateSchema);
    if (!parsed.ok) return jsonError(400, parsed.error);
    const ts = parsed.value.when ?? new Date().toISOString();
    const row = await env.DB
      .prepare("INSERT INTO weights (ts, weight_g) VALUES (?, ?) RETURNING id, ts, weight_g")
      .bind(ts, parsed.value.weight_g)
      .first<WeightRow>();
    return jsonOk(row, 201);
  }
  if (method === "DELETE" && idStr) {
    const id = parseIdParam(idStr);
    if (id === null) return jsonError(400, "Invalid id.");
    const ok = await deleteRow(env.DB, "weights", id);
    if (!ok) return jsonError(404, "Not found.");
    return jsonOk({ deleted: id });
  }
  return jsonError(405, "Method not allowed.");
}

async function apiHeights(
  method: string,
  url: URL,
  idStr: string | undefined,
  request: Request,
  env: Env
): Promise<Response> {
  if (method === "GET" && !idStr) {
    const since = url.searchParams.get("since");
    const until = url.searchParams.get("until");
    const limit = parseLimit(url.searchParams.get("limit"));
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (since) { clauses.push("ts >= ?"); params.push(since); }
    if (until) { clauses.push("ts < ?"); params.push(until); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    const items = await listRows<HeightRow>(
      env.DB,
      `SELECT id, ts, height_cm FROM heights ${where} ORDER BY ts DESC LIMIT ?`,
      params
    );
    return jsonOk({ items });
  }
  if (method === "POST" && !idStr) {
    const parsed = await readBody(request, HeightCreateSchema);
    if (!parsed.ok) return jsonError(400, parsed.error);
    const ts = parsed.value.when ?? new Date().toISOString();
    const row = await env.DB
      .prepare("INSERT INTO heights (ts, height_cm) VALUES (?, ?) RETURNING id, ts, height_cm")
      .bind(ts, parsed.value.height_cm)
      .first<HeightRow>();
    return jsonOk(row, 201);
  }
  if (method === "DELETE" && idStr) {
    const id = parseIdParam(idStr);
    if (id === null) return jsonError(400, "Invalid id.");
    const ok = await deleteRow(env.DB, "heights", id);
    if (!ok) return jsonError(404, "Not found.");
    return jsonOk({ deleted: id });
  }
  return jsonError(405, "Method not allowed.");
}

async function handleApi(
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
  const entity = parts[1];
  const idStr = parts[2];
  const method = request.method.toUpperCase();
  switch (entity) {
    case "feedings": return apiFeedings(method, url, idStr, request, env);
    case "diapers":  return apiDiapers(method, url, idStr, request, env);
    case "routines": return apiRoutines(method, url, idStr, request, env);
    case "notes":    return apiNotes(method, url, idStr, request, env);
    case "weights":  return apiWeights(method, url, idStr, request, env);
    case "heights":  return apiHeights(method, url, idStr, request, env);
    default:         return jsonError(404, "Unknown entity.");
  }
}

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
