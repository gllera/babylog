export type Env = {
  DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
  // Cloudflare Access (Managed OAuth) gates the host; the Worker verifies the
  // forwarded Access JWT against these and reads its email claim.
  TEAM_DOMAIN: string;
  POLICY_AUD: string;
  ALEXA_APPLICATION_ID?: string;
  ALEXA_SKIP_SIGNATURE?: string;
  // Household that Alexa-logged events belong to (default "1").
  ALEXA_HOUSEHOLD_ID?: string;
  // Local dev only (.dev.vars): identity assumed when no Access JWT is
  // present. Never set in production.
  DEV_USER_EMAIL?: string;
};

export type FeedingRow = {
  id: number;
  ts: string;
  amount_ml: number;
};

export type DiaperKind = "pee" | "poop";

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

export type BabyRow = {
  id: number;
  household_id: number;
  name: string | null;
  sex: "male" | "female" | null;
  date_of_birth: string | null;
  is_default: number;
};

export type UserRow = {
  id: number;
  email: string;
  household_id: number;
};
