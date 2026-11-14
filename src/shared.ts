// Shared types and helpers for the relay worker and the Room Durable Object.

export interface Env {
  ROOM: DurableObjectNamespace<import("./room").Room>;
  OAUTH_KV: KVNamespace;
  /** Bootstrap secret for POST /admin/rooms. Set with `wrangler secret put ADMIN_TOKEN`. */
  ADMIN_TOKEN?: string;
  OAUTH_PROVIDER?: unknown;
  /** Override the 30/min per-member send limit (local benchmarks only). */
  RATE_PER_MINUTE?: string;
  /** Override how long a pairing code lasts, in seconds (local tests only; default 600). */
  PAIRING_TTL_S?: string;
  /** Local tests only: lets POST /admin/rooms build a room with the pre-approval schema. Never set on the live Worker. */
  TEST_HOOKS?: string;
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
const TOKEN_RE = /^plk?_([a-z0-9][a-z0-9-]{2,39})_([A-Za-z0-9_-]{43})$/;

/** Room limits from the brief. */
export const LIMITS = { keep: 5000, maxText: 4000, perMinute: 30, maxWaitS: 50, readMax: 200, pairingTtlS: 600, maxPerInvite: 3, maxRequests: 5 } as const;

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function randomId(bytes = 8) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** A fresh invite token: 32 random bytes, prefixed with the room so the worker can route it. */
export function newToken(room: string) {
  return `pl_${room}_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** A pairing code for the requester and the owner to compare: six random digits, shown as "482 913". */
export function pairingCode() {
  const b = new Uint32Array(1);
  do crypto.getRandomValues(b); while (b[0] >= 4_294_000_000); // drop the uneven tail so every code is equally likely
  return String(b[0] % 1_000_000).padStart(6, "0").replace(/^(\d{3})/, "$1 ");
}

/** What a caller is told when it uses an unapproved invite as if it were a connection token. It
 *  carries no pairing code: a code is only ever shown to the one client that knocked for it. */
export const INVITE_ONLY = "this invite has not been approved yet, and an invite is not a connection token. Exchange it first: run bin/phoneline-join with it (it shows a pairing code, waits for the room owner to approve, and saves a member token that only you hold), or open the invite link in a browser, or paste the invite on the claude.ai sign-in page. Then connect with that member token, not the invite. Tell your user.";
export const INVITE_USED = "this invite has already been used and no longer works. Connect with the member token that was issued when the owner approved (phoneline-join saved it to your token file), or ask the room owner for a new invite.";

/** The secret a knocking client gets back once: only its holder can wait on, and collect, that request. */
export function newSecret(room: string) {
  return `plk_${room}_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** The room a token (pl_…) or a knock secret (plk_…) belongs to, or null if it is neither. */
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
  "а": "a", "в": "b", "с": "c", "ԁ": "d", "е": "e", "һ": "h", "н": "h", "і": "l", "ј": "j", "к": "k", "м": "m",
  "о": "o", "р": "p", "ѕ": "s", "т": "t", "у": "y", "х": "x", "ё": "e",
  "α": "a", "β": "b", "ε": "e", "ι": "l", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
  "ı": "l", "i": "l", "ǀ": "l", "ӏ": "l", "1": "l", "0": "o"
};

/** One alphabet per name, and Latin letters must be ordinary ones. Deny by default: a Latin letter
 *  next to any letter of another script, or a rare Latin-script letter that passes for a common one
 *  (ɑ, ɩ, ʟ …), is refused. Returns what is wrong, or null. */
export function nameProblem(name: string): string | null {
  // Punctuation and symbols could make a name read like part of a rendered line ("Ann (human) → all: …").
  if (!/^[\p{L}0-9 ._'’-]+$/u.test(name)) return "use only letters, digits, spaces and - _ . ' in a display name";
  let latin = false, other = false;
  for (const ch of name) {
    if (/\p{Script=Latin}/u.test(ch)) {
      latin = true;
      const plain = ch.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
      if (!/^[a-zßæøłđþðœ]+$/.test(plain)) return "use ordinary letters in a display name";
    } else if (/\p{L}/u.test(ch)) other = true;
  }
  return latin && other ? "use one alphabet in a display name" : null;
}

/** Two names that read the same count as the same name: case, accents, spacing and lookalike letters are ignored. */
export function nameKey(name: string): string {
  const base = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  // A letter that a pair of letters can be drawn as is spelled out as that pair (m as rn, w as vv,
  // d as cl), so both readings give the same key whatever order the letters come in.
  const PAIR: Record<string, string> = { m: "rn", w: "vv", d: "cl" };
  return Array.from(base, (ch) => { const c = LOOKALIKE[ch] ?? ch; return PAIR[c] ?? c; }).join("");
}

export class RelayError extends Error {
  constructor(public code: "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "bad_request" | "revoked" | "pending", msg: string) {
    super(`${code}: ${msg}`);
  }
}

export function errorCode(e: unknown): { code: string; message: string; status: number } {
  const message = e instanceof Error ? e.message : String(e);
  const code = /^(\w+):/.exec(message)?.[1] ?? "error";
  const status = { unauthorized: 401, revoked: 401, forbidden: 403, pending: 403, not_found: 404, rate_limited: 429, bad_request: 400 }[code] ?? 500;
  return { code, message, status };
}
