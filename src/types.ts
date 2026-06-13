export type Env = {
  DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
  // Cloudflare Access (Managed OAuth) gates /mcp; the Worker verifies the
  // forwarded Access JWT against these.
  TEAM_DOMAIN: string;
  POLICY_AUD: string;
  ALEXA_APPLICATION_ID?: string;
  ALEXA_SKIP_SIGNATURE?: string;
};

export type FeedingRow = {
  id: number;
  ts: string;
  amount_ml: number;
};

export type DiaperKind = "pee" | "poop" | "both";

export type DiaperRow = {
  id: number;
  ts: string;
  kind: DiaperKind;
};

export type RoutineRow = {
  id: number;
  ts: string;
  name: string;
};

export type NoteRow = {
  id: number;
  ts: string;
  text: string;
};

export type WeightRow = {
  id: number;
  ts: string;
  weight_g: number;
};

export type HeightRow = {
  id: number;
  ts: string;
  height_cm: number;
};

export type ProfileRow = {
  name: string | null;
  sex: "male" | "female" | "other" | null;
  date_of_birth: string | null;
};
