// Shared types and helpers for the relay worker and the Room Durable Object.

export interface Env {
  ROOM: DurableObjectNamespace<import("./room").Room>;
  OAUTH_KV: KVNamespace;
  /** Bootstrap secret for POST /admin/rooms. Set with `wrangler secret put ADMIN_TOKEN`. */
  ADMIN_TOKEN?: string;
  OAUTH_PROVIDER?: unknown;
  /** Override the 30/min per-member send limit (local benchmarks only). */
  RATE_PER_MINUTE?: string;
}

export type Role = "owner" | "member" | "read-only";
export type Kind = "agent" | "human";
export const ROLES: Role[] = ["owner", "member", "read-only"];
export const KINDS: Kind[] = ["agent", "human"];
export const TYPES = ["chat", "status", "question", "blocked", "done", "decision"] as const;
export type MsgType = (typeof TYPES)[number];

export interface Member {
  id: string;
  name: string;
  kind: Kind;
  role: Role;
}

export interface Msg {
  id: string;
  seq: number;
  room: string;
  from: { id: string; name: string; kind: Kind };
  to: string | null;
  type: MsgType;
  text: string;
  reply_to: number | null;
  ts: number;
}

/** What an authenticated request carries (ctx.props for /mcp, or resolved per HTTP call). */
export interface Props {
  room: string;
  member_id: string;
}

export const ROOM_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const TOKEN_RE = /^pl_([a-z0-9][a-z0-9-]{2,39})_([A-Za-z0-9_-]{43})$/;

/** Room limits from the brief. */
export const LIMITS = { keep: 5000, maxText: 4000, perMinute: 30, maxWaitS: 50, readMax: 200 } as const;

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function randomId(bytes = 8) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** A fresh invite token: 32 random bytes, prefixed with the room so the worker can route it. */
export function newToken(room: string) {
  return `pl_${room}_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** The room a token belongs to, or null if it is not a relay token. */
export function tokenRoom(token: string): string | null {
  const m = TOKEN_RE.exec(token);
  return m ? m[1] : null;
}

export async function hashToken(token: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Errors thrown across RPC keep their message, so codes ride in a prefix: "forbidden: …". */
/** A display name or addressee as it may be stored and rendered: no control, format, invisible or
 *  line-break characters (they let a name fake a new line or hide a difference), single spaces, 60 chars. */
export function cleanName(v: unknown): string {
  return String(v ?? "")
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115f\u1160\u3164\uffa0\u180e\u061c]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 60);
}

// Letters from other alphabets that are drawn like Latin ones. Not the full Unicode confusables
// list, but it covers the Cyrillic and Greek lookalikes that make one name pass for another.
const LOOKALIKE: Record<string, string> = {
  "а": "a", "в": "b", "с": "c", "ԁ": "d", "е": "e", "һ": "h", "н": "h", "і": "i", "ј": "j", "к": "k", "м": "m",
  "о": "o", "р": "p", "ѕ": "s", "т": "t", "у": "y", "х": "x", "ё": "e",
  "α": "a", "β": "b", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
  "ı": "i", "ǀ": "l", "0": "o", "1": "l"
};

/** Two names that read the same count as the same name: case, accents, spacing and lookalike letters are ignored. */
export function nameKey(name: string): string {
  const base = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  return Array.from(base, (ch) => LOOKALIKE[ch] ?? ch).join("");
}

export class RelayError extends Error {
  constructor(public code: "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "bad_request" | "revoked", msg: string) {
    super(`${code}: ${msg}`);
  }
}

export function errorCode(e: unknown): { code: string; message: string; status: number } {
  const message = e instanceof Error ? e.message : String(e);
  const code = /^(\w+):/.exec(message)?.[1] ?? "error";
  const status = { unauthorized: 401, revoked: 401, forbidden: 403, not_found: 404, rate_limited: 429, bad_request: 400 }[code] ?? 500;
  return { code, message, status };
}
