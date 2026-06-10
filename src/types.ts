import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export type Env = {
  DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  SHARED_SECRET?: string;
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
