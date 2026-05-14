import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  OAuthProvider,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";

type Env = {
  DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  SHARED_SECRET?: string;
};

type FeedingRow = {
  id: number;
  ts: string;
  amount_ml: number;
  note: string | null;
};

type DiaperKind = "pee" | "poop" | "both";

type DiaperRow = {
  id: number;
  ts: string;
  kind: DiaperKind;
  note: string | null;
};

type MedicationRow = {
  id: number;
  ts: string;
  name: string;
  dose: string | null;
  note: string | null;
};

type ObservationRow = {
  id: number;
  ts: string;
  text: string;
  category: string | null;
};

type WeightRow = {
  id: number;
  ts: string;
  weight_kg: number;
  note: string | null;
};

type HeightRow = {
  id: number;
  ts: string;
  height_cm: number;
  note: string | null;
};

type ProfileRow = {
  name: string | null;
  sex: "male" | "female" | "other" | null;
  date_of_birth: string | null;
};

function computeAge(dob: string): string {
  const birth = new Date(`${dob}T00:00:00Z`);
  const now = new Date();
  const days = Math.floor((now.getTime() - birth.getTime()) / 86400000);
  if (days < 0) return "not yet born";
  if (days < 60) {
    const weeks = Math.floor(days / 7);
    const rem = days % 7;
    if (weeks === 0) return `${days} day${days === 1 ? "" : "s"} old`;
    return `${days} days old (${weeks}w${rem > 0 ? ` ${rem}d` : ""})`;
  }
  let years = now.getUTCFullYear() - birth.getUTCFullYear();
  let months = now.getUTCMonth() - birth.getUTCMonth();
  if (now.getUTCDate() < birth.getUTCDate()) months--;
  if (months < 0) {
    years--;
    months += 12;
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

type IndicationMetric =
  | "feeding_total_ml"
  | "feeding_count"
  | "diaper_count"
  | "medication_count"
  | "observation_count";

type IndicationRow = {
  id: number;
  label: string;
  metric: IndicationMetric;
  filter: string | null;
  target: number;
  comparison: ">=" | "<=";
  period_days: number;
  active: number;
  note: string | null;
};

async function computeIndicationActual(
  db: D1Database,
  metric: IndicationMetric,
  filter: string | null,
  start: string,
  end: string
): Promise<number> {
  switch (metric) {
    case "feeding_total_ml": {
      const r = await db
        .prepare(
          "SELECT COALESCE(SUM(amount_ml), 0) AS v FROM feedings WHERE ts >= ? AND ts < ?"
        )
        .bind(start, end)
        .first<{ v: number }>();
      return r?.v ?? 0;
    }
    case "feeding_count": {
      const r = await db
        .prepare(
          "SELECT COUNT(*) AS v FROM feedings WHERE ts >= ? AND ts < ?"
        )
        .bind(start, end)
        .first<{ v: number }>();
      return r?.v ?? 0;
    }
    case "diaper_count": {
      let sql =
        "SELECT COUNT(*) AS v FROM diapers WHERE ts >= ? AND ts < ?";
      const params: (string | number)[] = [start, end];
      if (filter === "pee") sql += " AND kind IN ('pee','both')";
      else if (filter === "poop") sql += " AND kind IN ('poop','both')";
      else if (filter === "both") sql += " AND kind = 'both'";
      const r = await db
        .prepare(sql)
        .bind(...params)
        .first<{ v: number }>();
      return r?.v ?? 0;
    }
    case "medication_count": {
      if (filter) {
        const r = await db
          .prepare(
            "SELECT COUNT(*) AS v FROM medications WHERE ts >= ? AND ts < ? AND LOWER(name) LIKE ?"
          )
          .bind(start, end, `%${filter.toLowerCase()}%`)
          .first<{ v: number }>();
        return r?.v ?? 0;
      }
      const r = await db
        .prepare(
          "SELECT COUNT(*) AS v FROM medications WHERE ts >= ? AND ts < ?"
        )
        .bind(start, end)
        .first<{ v: number }>();
      return r?.v ?? 0;
    }
    case "observation_count": {
      if (filter) {
        const r = await db
          .prepare(
            "SELECT COUNT(*) AS v FROM observations WHERE ts >= ? AND ts < ? AND LOWER(category) = ?"
          )
          .bind(start, end, filter.toLowerCase())
          .first<{ v: number }>();
        return r?.v ?? 0;
      }
      const r = await db
        .prepare(
          "SELECT COUNT(*) AS v FROM observations WHERE ts >= ? AND ts < ?"
        )
        .bind(start, end)
        .first<{ v: number }>();
      return r?.v ?? 0;
    }
  }
}

function indicationUnit(metric: IndicationMetric): string {
  return metric === "feeding_total_ml" ? "ml" : "";
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
      },
      async () => {
        const row = await this.env.DB.prepare(
          "SELECT name, sex, date_of_birth FROM profile WHERE id = 1"
        ).first<ProfileRow>();
        return {
          content: [{ type: "text", text: formatProfile(row) }],
        };
      }
    );

    this.server.registerTool(
      "record_feeding",
      {
        description:
          "Record a milk feeding for the baby. If the user does not specify a time, OMIT the `when` parameter — the server records the feeding at the current time. Only pass `when` if the user gave an explicit past/future time.",
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
          note: z
            .string()
            .max(500)
            .optional()
            .describe(
              "Optional note, e.g. 'formula', 'breast milk', 'fussy', 'spit up'"
            ),
        },
      },
      async ({ amount_ml, when, note }) => {
        const ts = when ?? new Date().toISOString();
        const inserted = await this.env.DB.prepare(
          "INSERT INTO feedings (ts, amount_ml, note) VALUES (?, ?, ?) RETURNING id"
        )
          .bind(ts, amount_ml, note ?? null)
          .first<{ id: number }>();

        const id = inserted?.id;
        return {
          content: [
            {
              type: "text",
              text: `Recorded feeding #${id}: ${amount_ml} ml at ${ts}${
                note ? ` — ${note}` : ""
              }.`,
            },
          ],
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
          limit: z
            .number()
            .int()
            .positive()
            .max(500)
            .optional()
            .describe("Maximum number of rows to return (default 50, max 500)"),
        },
      },
      async ({ since, until, limit }) => {
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
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        params.push(limit ?? 50);

        const { results } = await this.env.DB.prepare(
          `SELECT id, ts, amount_ml, note FROM feedings ${where} ORDER BY ts DESC LIMIT ?`
        )
          .bind(...params)
          .all<FeedingRow>();

        if (results.length === 0) {
          return {
            content: [
              { type: "text", text: "No feedings recorded in that range." },
            ],
          };
        }

        const lines = results.map(
          (r) =>
            `#${r.id}  ${r.ts}  ${r.amount_ml} ml${
              r.note ? `  — ${r.note}` : ""
            }`
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
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
      async ({ id }) => {
        const res = await this.env.DB.prepare(
          "DELETE FROM feedings WHERE id = ?"
        )
          .bind(id)
          .run();
        const changes = res.meta.changes ?? 0;
        return {
          content: [
            {
              type: "text",
              text:
                changes > 0
                  ? `Deleted feeding #${id}.`
                  : `No feeding with id #${id} found.`,
            },
          ],
        };
      }
    );

    this.server.registerTool(
      "record_diaper",
      {
        description:
          "Record a diaper change — pee, poop, or both. If the user does not specify a time, OMIT the `when` parameter — the server records the change at the current time. Only pass `when` if the user gave an explicit past/future time.",
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
          note: z
            .string()
            .max(500)
            .optional()
            .describe(
              "Optional note, e.g. consistency, color, or 'blowout'"
            ),
        },
      },
      async ({ kind, when, note }) => {
        const ts = when ?? new Date().toISOString();
        const inserted = await this.env.DB.prepare(
          "INSERT INTO diapers (ts, kind, note) VALUES (?, ?, ?) RETURNING id"
        )
          .bind(ts, kind, note ?? null)
          .first<{ id: number }>();

        return {
          content: [
            {
              type: "text",
              text: `Recorded diaper #${inserted?.id}: ${kind} at ${ts}${
                note ? ` — ${note}` : ""
              }.`,
            },
          ],
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
          limit: z
            .number()
            .int()
            .positive()
            .max(500)
            .optional()
            .describe("Maximum number of rows to return (default 50, max 500)"),
        },
      },
      async ({ since, until, kind, limit }) => {
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
        if (kind) {
          clauses.push("kind = ?");
          params.push(kind);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        params.push(limit ?? 50);

        const { results } = await this.env.DB.prepare(
          `SELECT id, ts, kind, note FROM diapers ${where} ORDER BY ts DESC LIMIT ?`
        )
          .bind(...params)
          .all<DiaperRow>();

        if (results.length === 0) {
          return {
            content: [
              { type: "text", text: "No diaper events in that range." },
            ],
          };
        }

        const lines = results.map(
          (r) =>
            `#${r.id}  ${r.ts}  ${r.kind}${r.note ? `  — ${r.note}` : ""}`
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
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
      async ({ id }) => {
        const res = await this.env.DB.prepare(
          "DELETE FROM diapers WHERE id = ?"
        )
          .bind(id)
          .run();
        const changes = res.meta.changes ?? 0;
        return {
          content: [
            {
              type: "text",
              text:
                changes > 0
                  ? `Deleted diaper #${id}.`
                  : `No diaper with id #${id} found.`,
            },
          ],
        };
      }
    );

    this.server.registerTool(
      "record_medication",
      {
        description:
          "Record a medication or supplement dose given to the baby (e.g. Vitamin D, Acetaminophen). If the user does not specify a time, OMIT the `when` parameter — the server records the dose at the current time. Only pass `when` if the user gave an explicit past/future time.",
        inputSchema: {
          name: z
            .string()
            .min(1)
            .max(100)
            .describe("Medication name, e.g. 'Vitamin D', 'Acetaminophen'"),
          dose: z
            .string()
            .max(50)
            .optional()
            .describe(
              "Free-form dose, e.g. '400 IU', '1 drop', '2.5 ml'. Omit if unknown."
            ),
          when: z
            .string()
            .datetime()
            .optional()
            .describe(
              "Optional ISO 8601 timestamp (e.g. 2026-05-14T07:30:00Z). OMIT this when the dose is happening now — the server fills in the current time."
            ),
          note: z
            .string()
            .max(500)
            .optional()
            .describe("Optional note, e.g. 'with food', 'spit out half'"),
        },
      },
      async ({ name, dose, when, note }) => {
        const ts = when ?? new Date().toISOString();
        const inserted = await this.env.DB.prepare(
          "INSERT INTO medications (ts, name, dose, note) VALUES (?, ?, ?, ?) RETURNING id"
        )
          .bind(ts, name, dose ?? null, note ?? null)
          .first<{ id: number }>();

        return {
          content: [
            {
              type: "text",
              text: `Recorded medication #${inserted?.id}: ${name}${
                dose ? ` ${dose}` : ""
              } at ${ts}${note ? ` — ${note}` : ""}.`,
            },
          ],
        };
      }
    );

    this.server.registerTool(
      "list_medications",
      {
        description:
          "List medication doses, most recent first. Optionally filter by time window and medication name (case-insensitive substring match).",
        inputSchema: {
          since: z
            .string()
            .datetime()
            .optional()
            .describe("Include doses on or after this ISO timestamp"),
          until: z
            .string()
            .datetime()
            .optional()
            .describe("Include doses strictly before this ISO timestamp"),
          name: z
            .string()
            .min(1)
            .max(100)
            .optional()
            .describe(
              "Filter by medication name (case-insensitive substring match, e.g. 'vitamin')"
            ),
          limit: z
            .number()
            .int()
            .positive()
            .max(500)
            .optional()
            .describe("Maximum number of rows to return (default 50, max 500)"),
        },
      },
      async ({ since, until, name, limit }) => {
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
        if (name) {
          clauses.push("LOWER(name) LIKE ?");
          params.push(`%${name.toLowerCase()}%`);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        params.push(limit ?? 50);

        const { results } = await this.env.DB.prepare(
          `SELECT id, ts, name, dose, note FROM medications ${where} ORDER BY ts DESC LIMIT ?`
        )
          .bind(...params)
          .all<MedicationRow>();

        if (results.length === 0) {
          return {
            content: [
              { type: "text", text: "No medications recorded in that range." },
            ],
          };
        }

        const lines = results.map(
          (r) =>
            `#${r.id}  ${r.ts}  ${r.name}${r.dose ? ` (${r.dose})` : ""}${
              r.note ? `  — ${r.note}` : ""
            }`
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }
    );

    this.server.registerTool(
      "delete_medication",
      {
        description: "Delete a medication dose by its numeric id.",
        inputSchema: {
          id: z
            .number()
            .int()
            .positive()
            .describe("Medication id to delete (from list_medications)"),
        },
      },
      async ({ id }) => {
        const res = await this.env.DB.prepare(
          "DELETE FROM medications WHERE id = ?"
        )
          .bind(id)
          .run();
        const changes = res.meta.changes ?? 0;
        return {
          content: [
            {
              type: "text",
              text:
                changes > 0
                  ? `Deleted medication #${id}.`
                  : `No medication with id #${id} found.`,
            },
          ],
        };
      }
    );

    this.server.registerTool(
      "record_observation",
      {
        description:
          "Record a free-form observation about the baby — anything that doesn't fit feedings, diapers, or medications. Examples: 'granitos en la cara' (pimples on the face), 'first smile', 'rash on left arm', 'fussy after nap'. If the user does not specify a time, OMIT the `when` parameter — the server uses the current time.",
        inputSchema: {
          text: z
            .string()
            .min(1)
            .max(2000)
            .describe(
              "The observation itself, in the user's own words. Required."
            ),
          category: z
            .string()
            .min(1)
            .max(50)
            .optional()
            .describe(
              "Optional category for grouping, e.g. 'skin', 'mood', 'sleep', 'milestone'. Use lowercase, single word when possible."
            ),
          when: z
            .string()
            .datetime()
            .optional()
            .describe(
              "Optional ISO 8601 timestamp. OMIT this when the observation is happening now — the server fills in the current time."
            ),
        },
      },
      async ({ text, category, when }) => {
        const ts = when ?? new Date().toISOString();
        const inserted = await this.env.DB.prepare(
          "INSERT INTO observations (ts, text, category) VALUES (?, ?, ?) RETURNING id"
        )
          .bind(ts, text, category ?? null)
          .first<{ id: number }>();

        return {
          content: [
            {
              type: "text",
              text: `Recorded observation #${inserted?.id}${
                category ? ` [${category}]` : ""
              } at ${ts}: ${text}`,
            },
          ],
        };
      }
    );

    this.server.registerTool(
      "list_observations",
      {
        description:
          "List observations, most recent first. Optionally filter by time window, category, or a substring of the text.",
        inputSchema: {
          since: z
            .string()
            .datetime()
            .optional()
            .describe("Include observations on or after this ISO timestamp"),
          until: z
            .string()
            .datetime()
            .optional()
            .describe("Include observations strictly before this ISO timestamp"),
          category: z
            .string()
            .min(1)
            .max(50)
            .optional()
            .describe("Filter by exact category (case-insensitive)"),
          search: z
            .string()
            .min(1)
            .max(200)
            .optional()
            .describe(
              "Substring to search for inside the observation text (case-insensitive)"
            ),
          limit: z
            .number()
            .int()
            .positive()
            .max(500)
            .optional()
            .describe("Maximum number of rows to return (default 50, max 500)"),
        },
      },
      async ({ since, until, category, search, limit }) => {
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
        if (category) {
          clauses.push("LOWER(category) = ?");
          params.push(category.toLowerCase());
        }
        if (search) {
          clauses.push("LOWER(text) LIKE ?");
          params.push(`%${search.toLowerCase()}%`);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        params.push(limit ?? 50);

        const { results } = await this.env.DB.prepare(
          `SELECT id, ts, text, category FROM observations ${where} ORDER BY ts DESC LIMIT ?`
        )
          .bind(...params)
          .all<ObservationRow>();

        if (results.length === 0) {
          return {
            content: [
              { type: "text", text: "No observations recorded in that range." },
            ],
          };
        }

        const lines = results.map(
          (r) =>
            `#${r.id}  ${r.ts}${r.category ? `  [${r.category}]` : ""}  ${
              r.text
            }`
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }
    );

    this.server.registerTool(
      "delete_observation",
      {
        description: "Delete an observation by its numeric id.",
        inputSchema: {
          id: z
            .number()
            .int()
            .positive()
            .describe("Observation id to delete (from list_observations)"),
        },
      },
      async ({ id }) => {
        const res = await this.env.DB.prepare(
          "DELETE FROM observations WHERE id = ?"
        )
          .bind(id)
          .run();
        const changes = res.meta.changes ?? 0;
        return {
          content: [
            {
              type: "text",
              text:
                changes > 0
                  ? `Deleted observation #${id}.`
                  : `No observation with id #${id} found.`,
            },
          ],
        };
      }
    );

    this.server.registerTool(
      "record_weight",
      {
        description:
          "Record a baby weight measurement in kilograms. If the user does not specify a time, OMIT the `when` parameter — the server uses the current time.",
        inputSchema: {
          weight_kg: z
            .number()
            .positive()
            .describe(
              "Weight in kilograms, e.g. 4.25. If the user gives grams or pounds, convert first."
            ),
          when: z
            .string()
            .datetime()
            .optional()
            .describe(
              "Optional ISO 8601 timestamp. OMIT this when the measurement is happening now."
            ),
          note: z
            .string()
            .max(500)
            .optional()
            .describe(
              "Optional note, e.g. 'pediatrician visit', 'at home, naked'"
            ),
        },
      },
      async ({ weight_kg, when, note }) => {
        const ts = when ?? new Date().toISOString();
        const inserted = await this.env.DB.prepare(
          "INSERT INTO weights (ts, weight_kg, note) VALUES (?, ?, ?) RETURNING id"
        )
          .bind(ts, weight_kg, note ?? null)
          .first<{ id: number }>();

        // Compute delta vs previous measurement.
        const prev = await this.env.DB.prepare(
          "SELECT ts, weight_kg FROM weights WHERE ts < ? ORDER BY ts DESC LIMIT 1"
        )
          .bind(ts)
          .first<{ ts: string; weight_kg: number }>();

        let delta = "";
        if (prev) {
          const diff = weight_kg - prev.weight_kg;
          const sign = diff >= 0 ? "+" : "";
          delta = `  (${sign}${diff.toFixed(3)} kg since ${prev.ts})`;
        }

        return {
          content: [
            {
              type: "text",
              text: `Recorded weight #${inserted?.id}: ${weight_kg} kg at ${ts}${delta}${
                note ? ` — ${note}` : ""
              }.`,
            },
          ],
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
          limit: z
            .number()
            .int()
            .positive()
            .max(500)
            .optional()
            .describe("Maximum number of rows to return (default 50, max 500)"),
        },
      },
      async ({ since, until, limit }) => {
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
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        params.push(limit ?? 50);

        const { results } = await this.env.DB.prepare(
          `SELECT id, ts, weight_kg, note FROM weights ${where} ORDER BY ts DESC LIMIT ?`
        )
          .bind(...params)
          .all<WeightRow>();

        if (results.length === 0) {
          return {
            content: [
              { type: "text", text: "No weight measurements in that range." },
            ],
          };
        }

        const lines = results.map(
          (r) =>
            `#${r.id}  ${r.ts}  ${r.weight_kg} kg${r.note ? `  — ${r.note}` : ""}`
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
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
      async ({ id }) => {
        const res = await this.env.DB.prepare(
          "DELETE FROM weights WHERE id = ?"
        )
          .bind(id)
          .run();
        const changes = res.meta.changes ?? 0;
        return {
          content: [
            {
              type: "text",
              text:
                changes > 0
                  ? `Deleted weight #${id}.`
                  : `No weight measurement with id #${id} found.`,
            },
          ],
        };
      }
    );

    this.server.registerTool(
      "record_height",
      {
        description:
          "Record a baby length/height measurement in centimeters (babies are measured lying down, so this is technically length). If the user does not specify a time, OMIT the `when` parameter — the server uses the current time.",
        inputSchema: {
          height_cm: z
            .number()
            .positive()
            .describe(
              "Length/height in centimeters, e.g. 54.5. If given in inches or meters, convert first."
            ),
          when: z
            .string()
            .datetime()
            .optional()
            .describe(
              "Optional ISO 8601 timestamp. OMIT this when the measurement is happening now."
            ),
          note: z
            .string()
            .max(500)
            .optional()
            .describe("Optional note, e.g. 'pediatrician visit'"),
        },
      },
      async ({ height_cm, when, note }) => {
        const ts = when ?? new Date().toISOString();
        const inserted = await this.env.DB.prepare(
          "INSERT INTO heights (ts, height_cm, note) VALUES (?, ?, ?) RETURNING id"
        )
          .bind(ts, height_cm, note ?? null)
          .first<{ id: number }>();

        const prev = await this.env.DB.prepare(
          "SELECT ts, height_cm FROM heights WHERE ts < ? ORDER BY ts DESC LIMIT 1"
        )
          .bind(ts)
          .first<{ ts: string; height_cm: number }>();

        let delta = "";
        if (prev) {
          const diff = height_cm - prev.height_cm;
          const sign = diff >= 0 ? "+" : "";
          delta = `  (${sign}${diff.toFixed(1)} cm since ${prev.ts})`;
        }

        return {
          content: [
            {
              type: "text",
              text: `Recorded height #${inserted?.id}: ${height_cm} cm at ${ts}${delta}${
                note ? ` — ${note}` : ""
              }.`,
            },
          ],
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
          limit: z
            .number()
            .int()
            .positive()
            .max(500)
            .optional()
            .describe("Maximum number of rows to return (default 50, max 500)"),
        },
      },
      async ({ since, until, limit }) => {
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
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        params.push(limit ?? 50);

        const { results } = await this.env.DB.prepare(
          `SELECT id, ts, height_cm, note FROM heights ${where} ORDER BY ts DESC LIMIT ?`
        )
          .bind(...params)
          .all<HeightRow>();

        if (results.length === 0) {
          return {
            content: [
              { type: "text", text: "No height measurements in that range." },
            ],
          };
        }

        const lines = results.map(
          (r) =>
            `#${r.id}  ${r.ts}  ${r.height_cm} cm${r.note ? `  — ${r.note}` : ""}`
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
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
      async ({ id }) => {
        const res = await this.env.DB.prepare(
          "DELETE FROM heights WHERE id = ?"
        )
          .bind(id)
          .run();
        const changes = res.meta.changes ?? 0;
        return {
          content: [
            {
              type: "text",
              text:
                changes > 0
                  ? `Deleted height #${id}.`
                  : `No height measurement with id #${id} found.`,
            },
          ],
        };
      }
    );

    this.server.registerTool(
      "add_indication",
      {
        description:
          "Define a target the baby's care should follow over a window of N days. Examples:\n  '1 poop a day' → metric='diaper_count', filter='poop', target=1\n  '500 ml of milk a day' → metric='feeding_total_ml', target=500\n  'Vitamin D once a day' → metric='medication_count', filter='vitamin d', target=1\n  'bath every 2 days' → metric='observation_count', filter='bath', target=1, period_days=2.",
        inputSchema: {
          label: z
            .string()
            .min(1)
            .max(120)
            .describe(
              "Short human-readable label, e.g. '1 poop per day', 'bath every 2 days'"
            ),
          metric: z
            .enum([
              "feeding_total_ml",
              "feeding_count",
              "diaper_count",
              "medication_count",
              "observation_count",
            ])
            .describe(
              "What to aggregate: feeding_total_ml (sum of feeding ml), feeding_count, diaper_count, medication_count, observation_count"
            ),
          target: z
            .number()
            .nonnegative()
            .describe("Threshold value, e.g. 500 (ml) or 1 (count)"),
          comparison: z
            .enum([">=", "<="])
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
              "Narrows the metric. diaper_count: 'pee' | 'poop' | 'both' (omit for any). medication_count: substring of medication name (e.g. 'vitamin d'). observation_count: exact observation category (e.g. 'bath'). Ignored for feeding metrics."
            ),
          note: z.string().max(500).optional().describe("Optional free text"),
        },
      },
      async ({
        label,
        metric,
        target,
        comparison,
        period_days,
        filter,
        note,
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
          (metric === "feeding_total_ml" || metric === "feeding_count") &&
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
          `INSERT INTO indications (label, metric, filter, target, comparison, period_days, note)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           RETURNING id`
        )
          .bind(
            label,
            metric,
            filter ?? null,
            target,
            comparison ?? ">=",
            period_days ?? 1,
            note ?? null
          )
          .first<{ id: number }>();

        const unit = indicationUnit(metric);
        const period = period_days ?? 1;
        const periodS = period === 1 ? "/d" : `/${period}d`;
        return {
          content: [
            {
              type: "text",
              text: `Added indication #${inserted?.id}: ${label}  [${metric}${
                filter ? `:${filter}` : ""
              } ${comparison ?? ">="} ${target}${unit ? " " + unit : ""}${periodS}]`,
            },
          ],
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
      },
      async ({ include_inactive }) => {
        const where = include_inactive ? "" : "WHERE active = 1";
        const { results } = await this.env.DB.prepare(
          `SELECT id, label, metric, filter, target, comparison, period_days, active, note
           FROM indications ${where}
           ORDER BY active DESC, id`
        ).all<IndicationRow>();

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
          };
        }

        const lines = results.map((r) => {
          const unit = indicationUnit(r.metric);
          const periodS = r.period_days === 1 ? "/d" : `/${r.period_days}d`;
          return `#${r.id}  ${r.active ? " " : "[off]"} ${r.label}  →  ${r.metric}${
            r.filter ? `:${r.filter}` : ""
          } ${r.comparison} ${r.target}${unit ? " " + unit : ""}${periodS}${
            r.note ? `  — ${r.note}` : ""
          }`;
        });
        return {
          content: [{ type: "text", text: lines.join("\n") }],
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
      async ({ id }) => {
        const res = await this.env.DB.prepare(
          "DELETE FROM indications WHERE id = ?"
        )
          .bind(id)
          .run();
        const changes = res.meta.changes ?? 0;
        return {
          content: [
            {
              type: "text",
              text:
                changes > 0
                  ? `Deleted indication #${id}.`
                  : `No indication with id #${id} found.`,
            },
          ],
        };
      }
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
      },
      async ({ date }) => {
        const day = date ?? new Date().toISOString().slice(0, 10);
        const endDate = new Date(`${day}T00:00:00.000Z`);
        endDate.setUTCDate(endDate.getUTCDate() + 1);
        const end = endDate.toISOString();

        const { results: indications } = await this.env.DB.prepare(
          `SELECT id, label, metric, filter, target, comparison, period_days, active, note
           FROM indications WHERE active = 1 ORDER BY id`
        ).all<IndicationRow>();

        if (indications.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  "No active indications. Use add_indication to define one (e.g. '1 poop a day').",
              },
            ],
          };
        }

        const lines: string[] = [`Indications evaluated as of ${day} (UTC):`];
        let met = 0;
        for (const ind of indications) {
          const startDate = new Date(`${day}T00:00:00.000Z`);
          startDate.setUTCDate(startDate.getUTCDate() - (ind.period_days - 1));
          const start = startDate.toISOString();

          const actual = await computeIndicationActual(
            this.env.DB,
            ind.metric,
            ind.filter,
            start,
            end
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
        }
        lines.push("");
        lines.push(`Met ${met}/${indications.length}.`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
    );

    this.server.registerTool(
      "get_stats",
      {
        description:
          "Summarize feedings, diapers, medications, and observations within a time window. Defaults to the last 24 hours.",
        inputSchema: {
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
      },
      async ({ since, until }) => {
        const end = until ?? new Date().toISOString();
        const start =
          since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

        const [feedAgg, diaperAgg, medAgg, medBreakdown, obsAgg] =
          await this.env.DB.batch([
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
               FROM medications
               WHERE ts >= ? AND ts < ?`
            ).bind(start, end),
            this.env.DB.prepare(
              `SELECT name, COUNT(*) AS n
               FROM medications
               WHERE ts >= ? AND ts < ?
               GROUP BY name
               ORDER BY n DESC`
            ).bind(start, end),
            this.env.DB.prepare(
              `SELECT COUNT(*) AS count, MAX(ts) AS last_ts
               FROM observations
               WHERE ts >= ? AND ts < ?`
            ).bind(start, end),
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
        const meds = medAgg.results[0] as {
          count: number;
          last_ts: string | null;
        };
        const medsByName = medBreakdown.results as Array<{
          name: string;
          n: number;
        }>;
        const obs = obsAgg.results[0] as {
          count: number;
          last_ts: string | null;
        };

        const profile = await this.env.DB.prepare(
          "SELECT name, sex, date_of_birth FROM profile WHERE id = 1"
        ).first<ProfileRow>();

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

        if (meds.count === 0) {
          lines.push("Medications: none");
        } else {
          const breakdown = medsByName
            .map((m) => `${m.name}×${m.n}`)
            .join(", ");
          lines.push(
            `Medications: ${meds.count}  (${breakdown}, last ${meds.last_ts})`
          );
        }

        if (obs.count === 0) {
          lines.push("Observations: none");
        } else {
          lines.push(`Observations: ${obs.count}  (last ${obs.last_ts})`);
        }

        // Latest weight + height (independent of the window — current state).
        const [latestWeight, latestHeight] = await Promise.all([
          this.env.DB.prepare(
            "SELECT ts, weight_kg FROM weights ORDER BY ts DESC LIMIT 1"
          ).first<{ ts: string; weight_kg: number }>(),
          this.env.DB.prepare(
            "SELECT ts, height_cm FROM heights ORDER BY ts DESC LIMIT 1"
          ).first<{ ts: string; height_cm: number }>(),
        ]);
        if (latestWeight || latestHeight) {
          lines.push("");
        }
        if (latestWeight) {
          lines.push(
            `Latest weight: ${latestWeight.weight_kg} kg  (measured ${latestWeight.ts})`
          );
        }
        if (latestHeight) {
          lines.push(
            `Latest height: ${latestHeight.height_cm} cm  (measured ${latestHeight.ts})`
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
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
<html>
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
    <p>This MCP client wants access to the baby feeding tracker.</p>
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
    if (url.pathname === "/") {
      return new Response(
        "Baby feeding MCP server — protected by OAuth. Connect via /mcp.\n",
        { headers: { "Content-Type": "text/plain" } }
      );
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
