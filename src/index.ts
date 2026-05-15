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
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Baby Tracker — Log in</title>
  <link rel="icon" href="/icon.svg">
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
    <h1>Baby Tracker</h1>
    <p>Log in to register feedings, diapers, medications, observations, weights, and heights.</p>
    <form method="POST" action="/app/login">
      ${nextAttr}
      <label for="pw">Password</label>
      <input id="pw" type="password" name="password" autocomplete="current-password" autofocus required>
      ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
      <button type="submit">Log in</button>
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
    return renderAppLogin("Missing password.", next);
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

const APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Baby Tracker</title>
  <link rel="icon" href="/icon.svg">
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
    header h1 {
      margin: 0;
      font-size: 1.05rem;
      font-weight: 700;
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
    .logout-btn {
      background: transparent;
      border: 1px solid var(--border);
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      color: var(--muted);
      font-family: inherit;
    }
    .logout-btn:hover { background: #f0f0f0; }
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
    .id-col { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 12px; width: 1px; white-space: nowrap; }
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
    @media (max-width: 640px) {
      header { padding: 10px 12px; }
      header h1 { font-size: 1rem; }
      nav button { padding: 5px 9px; font-size: 13px; }
      th, td { padding: 8px 10px; }
      .hide-sm { display: none; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Baby Tracker</h1>
    <nav id="nav">
      <button data-tab="feedings" class="active">Feedings</button>
      <button data-tab="diapers">Diapers</button>
      <button data-tab="medications">Medications</button>
      <button data-tab="observations">Observations</button>
      <button data-tab="weights">Weights</button>
      <button data-tab="heights">Heights</button>
    </nav>
    <form method="POST" action="/app/logout" style="margin:0">
      <button class="logout-btn" type="submit">Log out</button>
    </form>
  </header>

  <main>
    <section id="tab-feedings" class="tab active">
      <form class="entry-form" data-entity="feedings">
        <label>Amount (ml)
          <input type="number" name="amount_ml" step="0.1" min="0.1" required placeholder="120">
        </label>
        <label>When (optional)
          <input type="datetime-local" name="when">
        </label>
        <label>Note
          <input type="text" name="note" maxlength="500" placeholder="formula, breast milk...">
        </label>
        <button type="submit">Add feeding</button>
      </form>
      <div class="list" id="list-feedings"><div class="list-loading">Loading...</div></div>
    </section>

    <section id="tab-diapers" class="tab">
      <form class="entry-form" data-entity="diapers">
        <label>Kind
          <select name="kind" required>
            <option value="pee">Pee</option>
            <option value="poop">Poop</option>
            <option value="both">Both</option>
          </select>
        </label>
        <label>When (optional)
          <input type="datetime-local" name="when">
        </label>
        <label>Note
          <input type="text" name="note" maxlength="500" placeholder="color, consistency...">
        </label>
        <button type="submit">Add diaper</button>
      </form>
      <div class="list" id="list-diapers"><div class="list-loading">Loading...</div></div>
    </section>

    <section id="tab-medications" class="tab">
      <form class="entry-form" data-entity="medications">
        <label>Name
          <input type="text" name="name" maxlength="100" required placeholder="Vitamin D">
        </label>
        <label>Dose
          <input type="text" name="dose" maxlength="50" placeholder="400 IU">
        </label>
        <label>When (optional)
          <input type="datetime-local" name="when">
        </label>
        <label>Note
          <input type="text" name="note" maxlength="500">
        </label>
        <button type="submit">Add medication</button>
      </form>
      <div class="list" id="list-medications"><div class="list-loading">Loading...</div></div>
    </section>

    <section id="tab-observations" class="tab">
      <form class="entry-form" data-entity="observations">
        <label>Text
          <input type="text" name="text" maxlength="2000" required placeholder="first smile, rash on left arm...">
        </label>
        <label>Category
          <input type="text" name="category" maxlength="50" placeholder="skin, mood, milestone...">
        </label>
        <label>When (optional)
          <input type="datetime-local" name="when">
        </label>
        <button type="submit">Add observation</button>
      </form>
      <div class="list" id="list-observations"><div class="list-loading">Loading...</div></div>
    </section>

    <section id="tab-weights" class="tab">
      <form class="entry-form" data-entity="weights">
        <label>Weight (kg)
          <input type="number" name="weight_kg" step="0.001" min="0.001" required placeholder="4.25">
        </label>
        <label>When (optional)
          <input type="datetime-local" name="when">
        </label>
        <label>Note
          <input type="text" name="note" maxlength="500" placeholder="pediatrician visit...">
        </label>
        <button type="submit">Add weight</button>
      </form>
      <div class="list" id="list-weights"><div class="list-loading">Loading...</div></div>
    </section>

    <section id="tab-heights" class="tab">
      <form class="entry-form" data-entity="heights">
        <label>Height (cm)
          <input type="number" name="height_cm" step="0.1" min="0.1" required placeholder="54.5">
        </label>
        <label>When (optional)
          <input type="datetime-local" name="when">
        </label>
        <label>Note
          <input type="text" name="note" maxlength="500">
        </label>
        <button type="submit">Add height</button>
      </form>
      <div class="list" id="list-heights"><div class="list-loading">Loading...</div></div>
    </section>
  </main>

  <div class="toast" id="toast"></div>

  <script>
    var NUMERIC_FIELDS = { amount_ml: true, weight_kg: true, height_cm: true };

    var entities = {
      feedings: {
        endpoint: "/api/feedings",
        columns: [
          { key: "id", label: "#", cls: "id-col", fmt: function(v) { return "#" + v; } },
          { key: "ts", label: "When", cls: "ts-col", fmt: fmtTs },
          { key: "amount_ml", label: "Amount", cls: "num-col", fmt: function(v) { return v + " ml"; } },
          { key: "note", label: "Note", fmt: fmtText }
        ]
      },
      diapers: {
        endpoint: "/api/diapers",
        columns: [
          { key: "id", label: "#", cls: "id-col", fmt: function(v) { return "#" + v; } },
          { key: "ts", label: "When", cls: "ts-col", fmt: fmtTs },
          { key: "kind", label: "Kind", fmt: fmtText },
          { key: "note", label: "Note", fmt: fmtText }
        ]
      },
      medications: {
        endpoint: "/api/medications",
        columns: [
          { key: "id", label: "#", cls: "id-col", fmt: function(v) { return "#" + v; } },
          { key: "ts", label: "When", cls: "ts-col", fmt: fmtTs },
          { key: "name", label: "Name", fmt: fmtText },
          { key: "dose", label: "Dose", fmt: fmtText },
          { key: "note", label: "Note", fmt: fmtText }
        ]
      },
      observations: {
        endpoint: "/api/observations",
        columns: [
          { key: "id", label: "#", cls: "id-col", fmt: function(v) { return "#" + v; } },
          { key: "ts", label: "When", cls: "ts-col", fmt: fmtTs },
          { key: "category", label: "Category", fmt: fmtText },
          { key: "text", label: "Text", fmt: fmtText }
        ]
      },
      weights: {
        endpoint: "/api/weights",
        columns: [
          { key: "id", label: "#", cls: "id-col", fmt: function(v) { return "#" + v; } },
          { key: "ts", label: "When", cls: "ts-col", fmt: fmtTs },
          { key: "weight_kg", label: "Weight", cls: "num-col", fmt: function(v) { return v + " kg"; } },
          { key: "note", label: "Note", fmt: fmtText }
        ]
      },
      heights: {
        endpoint: "/api/heights",
        columns: [
          { key: "id", label: "#", cls: "id-col", fmt: function(v) { return "#" + v; } },
          { key: "ts", label: "When", cls: "ts-col", fmt: fmtTs },
          { key: "height_cm", label: "Height", cls: "num-col", fmt: function(v) { return v + " cm"; } },
          { key: "note", label: "Note", fmt: fmtText }
        ]
      }
    };

    function fmtTs(s) {
      if (!s) return "";
      var d = new Date(s);
      if (isNaN(d.getTime())) return s;
      return d.toLocaleString();
    }
    function fmtText(v) { return v == null ? "" : String(v); }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
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

    async function loadList(entity) {
      var cfg = entities[entity];
      var container = document.getElementById("list-" + entity);
      try {
        var res = await fetch(cfg.endpoint, { headers: { Accept: "application/json" } });
        if (res.status === 401) { location.href = "/app/login?next=" + encodeURIComponent(location.pathname); return; }
        if (!res.ok) throw new Error("HTTP " + res.status);
        var data = await res.json();
        renderList(entity, data.items || []);
      } catch (err) {
        container.innerHTML = '<div class="list-empty">Failed to load: ' + escapeHtml(err.message) + "</div>";
      }
    }

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
          var rendered = col.fmt ? col.fmt(val) : (val == null ? "" : val);
          row += "<td" + (col.cls ? ' class="' + col.cls + '"' : "") + ">" + escapeHtml(rendered) + "</td>";
        }
        row += '<td class="actions-col"><button class="delete-btn" data-id="' + item.id + '" data-entity="' + entity + '">Delete</button></td>';
        body += "<tr>" + row + "</tr>";
      }
      container.innerHTML = "<table><thead><tr>" + head + "</tr></thead><tbody>" + body + "</tbody></table>";
    }

    function showTab(name) {
      var navBtns = document.querySelectorAll("#nav button");
      for (var i = 0; i < navBtns.length; i++) {
        navBtns[i].classList.toggle("active", navBtns[i].getAttribute("data-tab") === name);
      }
      var tabs = document.querySelectorAll(".tab");
      for (var j = 0; j < tabs.length; j++) {
        tabs[j].classList.toggle("active", tabs[j].id === "tab-" + name);
      }
      loadList(name);
    }

    document.getElementById("nav").addEventListener("click", function(e) {
      var t = e.target;
      if (t && t.tagName === "BUTTON" && t.getAttribute("data-tab")) {
        showTab(t.getAttribute("data-tab"));
      }
    });

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
          var res = await fetch(entities[entity].endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(body)
          });
          if (res.status === 401) { location.href = "/app/login?next=" + encodeURIComponent(location.pathname); return; }
          if (!res.ok) {
            var errText = await res.text();
            toast("Error: " + errText, true);
            return;
          }
          form.reset();
          toast("Saved");
          loadList(entity);
        } catch (err) {
          toast("Network error: " + err.message, true);
        } finally {
          submitBtn.disabled = false;
        }
      });
    }

    document.addEventListener("click", async function(e) {
      var t = e.target;
      if (t && t.classList && t.classList.contains("delete-btn")) {
        if (!confirm("Delete this entry?")) return;
        var id = t.getAttribute("data-id");
        var entity = t.getAttribute("data-entity");
        t.disabled = true;
        try {
          var res = await fetch(entities[entity].endpoint + "/" + encodeURIComponent(id), { method: "DELETE" });
          if (res.status === 401) { location.href = "/app/login?next=" + encodeURIComponent(location.pathname); return; }
          if (!res.ok) {
            toast("Delete failed", true);
            return;
          }
          toast("Deleted");
          loadList(entity);
        } catch (err) {
          toast("Network error: " + err.message, true);
        }
      }
    });

    showTab("feedings");
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
  note: z.string().max(500).optional(),
});

const DiaperCreateSchema = z.object({
  kind: z.enum(["pee", "poop", "both"]),
  when: z.string().datetime().optional(),
  note: z.string().max(500).optional(),
});

const MedicationCreateSchema = z.object({
  name: z.string().min(1).max(100),
  dose: z.string().max(50).optional(),
  when: z.string().datetime().optional(),
  note: z.string().max(500).optional(),
});

const ObservationCreateSchema = z.object({
  text: z.string().min(1).max(2000),
  category: z.string().min(1).max(50).optional(),
  when: z.string().datetime().optional(),
});

const WeightCreateSchema = z.object({
  weight_kg: z.number().positive(),
  when: z.string().datetime().optional(),
  note: z.string().max(500).optional(),
});

const HeightCreateSchema = z.object({
  height_cm: z.number().positive(),
  when: z.string().datetime().optional(),
  note: z.string().max(500).optional(),
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
      `SELECT id, ts, amount_ml, note FROM feedings ${where} ORDER BY ts DESC LIMIT ?`,
      params
    );
    return jsonOk({ items });
  }
  if (method === "POST" && !idStr) {
    const parsed = await readBody(request, FeedingCreateSchema);
    if (!parsed.ok) return jsonError(400, parsed.error);
    const ts = parsed.value.when ?? new Date().toISOString();
    const row = await env.DB
      .prepare("INSERT INTO feedings (ts, amount_ml, note) VALUES (?, ?, ?) RETURNING id, ts, amount_ml, note")
      .bind(ts, parsed.value.amount_ml, parsed.value.note ?? null)
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
      `SELECT id, ts, kind, note FROM diapers ${where} ORDER BY ts DESC LIMIT ?`,
      params
    );
    return jsonOk({ items });
  }
  if (method === "POST" && !idStr) {
    const parsed = await readBody(request, DiaperCreateSchema);
    if (!parsed.ok) return jsonError(400, parsed.error);
    const ts = parsed.value.when ?? new Date().toISOString();
    const row = await env.DB
      .prepare("INSERT INTO diapers (ts, kind, note) VALUES (?, ?, ?) RETURNING id, ts, kind, note")
      .bind(ts, parsed.value.kind, parsed.value.note ?? null)
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

async function apiMedications(
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
    const items = await listRows<MedicationRow>(
      env.DB,
      `SELECT id, ts, name, dose, note FROM medications ${where} ORDER BY ts DESC LIMIT ?`,
      params
    );
    return jsonOk({ items });
  }
  if (method === "POST" && !idStr) {
    const parsed = await readBody(request, MedicationCreateSchema);
    if (!parsed.ok) return jsonError(400, parsed.error);
    const ts = parsed.value.when ?? new Date().toISOString();
    const row = await env.DB
      .prepare("INSERT INTO medications (ts, name, dose, note) VALUES (?, ?, ?, ?) RETURNING id, ts, name, dose, note")
      .bind(ts, parsed.value.name, parsed.value.dose ?? null, parsed.value.note ?? null)
      .first<MedicationRow>();
    return jsonOk(row, 201);
  }
  if (method === "DELETE" && idStr) {
    const id = parseIdParam(idStr);
    if (id === null) return jsonError(400, "Invalid id.");
    const ok = await deleteRow(env.DB, "medications", id);
    if (!ok) return jsonError(404, "Not found.");
    return jsonOk({ deleted: id });
  }
  return jsonError(405, "Method not allowed.");
}

async function apiObservations(
  method: string,
  url: URL,
  idStr: string | undefined,
  request: Request,
  env: Env
): Promise<Response> {
  if (method === "GET" && !idStr) {
    const since = url.searchParams.get("since");
    const until = url.searchParams.get("until");
    const category = url.searchParams.get("category");
    const search = url.searchParams.get("search");
    const limit = parseLimit(url.searchParams.get("limit"));
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (since) { clauses.push("ts >= ?"); params.push(since); }
    if (until) { clauses.push("ts < ?"); params.push(until); }
    if (category) { clauses.push("LOWER(category) = ?"); params.push(category.toLowerCase()); }
    if (search) { clauses.push("LOWER(text) LIKE ?"); params.push(`%${search.toLowerCase()}%`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    const items = await listRows<ObservationRow>(
      env.DB,
      `SELECT id, ts, text, category FROM observations ${where} ORDER BY ts DESC LIMIT ?`,
      params
    );
    return jsonOk({ items });
  }
  if (method === "POST" && !idStr) {
    const parsed = await readBody(request, ObservationCreateSchema);
    if (!parsed.ok) return jsonError(400, parsed.error);
    const ts = parsed.value.when ?? new Date().toISOString();
    const row = await env.DB
      .prepare("INSERT INTO observations (ts, text, category) VALUES (?, ?, ?) RETURNING id, ts, text, category")
      .bind(ts, parsed.value.text, parsed.value.category ?? null)
      .first<ObservationRow>();
    return jsonOk(row, 201);
  }
  if (method === "DELETE" && idStr) {
    const id = parseIdParam(idStr);
    if (id === null) return jsonError(400, "Invalid id.");
    const ok = await deleteRow(env.DB, "observations", id);
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
      `SELECT id, ts, weight_kg, note FROM weights ${where} ORDER BY ts DESC LIMIT ?`,
      params
    );
    return jsonOk({ items });
  }
  if (method === "POST" && !idStr) {
    const parsed = await readBody(request, WeightCreateSchema);
    if (!parsed.ok) return jsonError(400, parsed.error);
    const ts = parsed.value.when ?? new Date().toISOString();
    const row = await env.DB
      .prepare("INSERT INTO weights (ts, weight_kg, note) VALUES (?, ?, ?) RETURNING id, ts, weight_kg, note")
      .bind(ts, parsed.value.weight_kg, parsed.value.note ?? null)
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
      `SELECT id, ts, height_cm, note FROM heights ${where} ORDER BY ts DESC LIMIT ?`,
      params
    );
    return jsonOk({ items });
  }
  if (method === "POST" && !idStr) {
    const parsed = await readBody(request, HeightCreateSchema);
    if (!parsed.ok) return jsonError(400, parsed.error);
    const ts = parsed.value.when ?? new Date().toISOString();
    const row = await env.DB
      .prepare("INSERT INTO heights (ts, height_cm, note) VALUES (?, ?, ?) RETURNING id, ts, height_cm, note")
      .bind(ts, parsed.value.height_cm, parsed.value.note ?? null)
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
    case "feedings":     return apiFeedings(method, url, idStr, request, env);
    case "diapers":      return apiDiapers(method, url, idStr, request, env);
    case "medications":  return apiMedications(method, url, idStr, request, env);
    case "observations": return apiObservations(method, url, idStr, request, env);
    case "weights":      return apiWeights(method, url, idStr, request, env);
    case "heights":      return apiHeights(method, url, idStr, request, env);
    default:             return jsonError(404, "Unknown entity.");
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
