import { DurableObject } from "cloudflare:workers";
import { type Env, type Kind, type Member, type Msg, type MsgType, type Role, LIMITS, RelayError, ROLES, KINDS, TYPES, cleanName, hashToken, nameKey, nameProblem, newSecret, newToken, pairingCode, randomId, INVITE_ONLY, INVITE_USED } from "./shared";

// One Durable Object per room. It owns the room's SQLite (members, messages, join requests),
// hands out seq numbers (the DO runs one request at a time, so seq never collides), and holds
// the waiters: MCP/HTTP long-polls and WebSockets that get each new message the moment it is
// written.
//
// Access: an invite is a one-time pairing ticket, not a connection token. A client "knocks" with
// it and gets a join request of its own: a pairing code to show its user, and a secret returned
// once that only it holds. The owner sees every request, approves one by its code, and the relay
// then gives a fresh member token (or the OAuth grant) only to the client holding that request's
// secret. The invite is used up: it stops working and every other request made with it is denied.
// So two parties holding the same invite get different codes, and only the approved one gets in.

type Waiter = { memberId: string; since: number; resolve: (r: WaitResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
export type WaitResult = { messages: Msg[]; last_seq: number; timed_out: boolean; me: string };
/** How a knocking client wants its approval: "peek" only looks, "token" collects a new member token,
 *  "grant" (the connector sign-in) uses the request up without a token. */
type ClaimMode = "peek" | "token" | "grant";
export type Claim = { state: "waiting" | "approved" | "expired"; code?: string; expires_in_s?: number; member?: Member; token?: string };
/** A knocking client's long-poll on its own request. */
type Knocker = { reqId: string; mode: ClaimMode; resolve: (r: Claim) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
export type JoinRequest = { member: Member; code: string; via: string; asked_at: number; expires_in_s: number; for_same_invite: number };
/** A socket is either a member's (mid) or a knocking client's, waiting on its request (req). */
type Attach = { mid?: string; req?: string };

type Row = Record<string, SqlStorageValue>;

const REVOKED = "your access to this room was revoked; tell your user and stop polling";
const DENIED = "the room owner denied your request to join; tell your user and stop";

export class Room extends DurableObject<Env> {
  private sql: SqlStorage;
  private waiters = new Set<Waiter>();
  private knockers = new Set<Knocker>();
  private sent = new Map<string, number[]>(); // member id → send times in the last minute
  private seen = new Map<string, number>(); // member id → last activity (presence)

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
  }

  /** Create what is missing. Runs every time the room wakes, so every step must be safe to repeat. */
  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, role TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, invited_by TEXT,
        status TEXT NOT NULL DEFAULT 'active', approved_by TEXT, approved_at INTEGER, used_invite TEXT);
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, from_id TEXT NOT NULL, from_name TEXT NOT NULL,
        from_kind TEXT NOT NULL, to_name TEXT, type TEXT NOT NULL, text TEXT NOT NULL, reply_to INTEGER,
        client_id TEXT, ts INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS messages_client ON messages (from_id, client_id) WHERE client_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS knocks (
        id TEXT PRIMARY KEY, member_id TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE, code TEXT NOT NULL, via TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'waiting', created INTEGER NOT NULL, expires INTEGER NOT NULL);
    `);
    // Rooms made before owner approval existed have a members table without these columns
    // (CREATE TABLE IF NOT EXISTS leaves an existing table alone). Add each one that is missing.
    // The default makes every member already in the room 'active', so nobody is locked out.
    const have = new Set(this.sql.exec("PRAGMA table_info(members)").toArray().map((r) => r.name as string));
    if (!have.has("status")) this.sql.exec("ALTER TABLE members ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    if (!have.has("approved_by")) this.sql.exec("ALTER TABLE members ADD COLUMN approved_by TEXT");
    if (!have.has("approved_at")) this.sql.exec("ALTER TABLE members ADD COLUMN approved_at INTEGER");
    if (!have.has("used_invite")) this.sql.exec("ALTER TABLE members ADD COLUMN used_invite TEXT");
  }

  // ---------- internals ----------

  private meta(k: string) {
    return (this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v as string | undefined) ?? null;
  }
  private roomId() {
    const id = this.meta("room");
    if (!id) throw new RelayError("not_found", "no such room");
    if (this.meta("deleted")) throw new RelayError("not_found", "this room was deleted");
    return id;
  }
  private lastSeq() {
    return Number(this.sql.exec("SELECT COALESCE(MAX(seq), 0) AS s FROM messages").one().s);
  }
  private toMember(r: Row): Member {
    return { id: r.id as string, name: r.name as string, kind: r.kind as Kind, role: r.role as Role };
  }
  private toMsg(r: Row, room: string): Msg {
    return {
      id: r.id as string, seq: Number(r.seq), room,
      from: { id: r.from_id as string, name: r.from_name as string, kind: r.from_kind as Kind },
      to: (r.to_name as string) ?? null, type: r.type as MsgType, text: r.text as string,
      reply_to: r.reply_to == null ? null : Number(r.reply_to), ts: Number(r.ts)
    };
  }
  /** The caller's member row, or a clear error if they were revoked / never existed.
   *  `who` is a member id (OAuth grants) or a token's sha256 (bearer calls): one DO hop either way. */
  private row(who: string): Row {
    this.roomId();
    const r = (who.length === 64
      ? this.sql.exec("SELECT * FROM members WHERE token_hash = ?", who)
      : this.sql.exec("SELECT * FROM members WHERE id = ?", who)).toArray()[0];
    if (!r) {
      const used = who.length === 64 && this.sql.exec("SELECT 1 FROM members WHERE used_invite = ?", who).toArray().length;
      throw new RelayError("unauthorized", used ? INVITE_USED : "not a member of this room");
    }
    if (r.revoked) throw new RelayError("revoked", REVOKED);
    return r;
  }
  /** The calling member. Every room method starts here, so this is the one gate: an invite that has
   *  not been exchanged for a member token gets told how to do that, and nothing else. */
  private me(who: string): Member {
    const r = this.row(who);
    if (r.status === "pending") throw new RelayError("pending", INVITE_ONLY);
    this.seen.set(r.id as string, Date.now());
    return this.toMember(r);
  }
  private owner(who: string, what: string): Member {
    const m = this.me(who);
    if (m.role !== "owner") throw new RelayError("forbidden", `only owners can ${what}`);
    return m;
  }
  private since(since: number, limit: number, room: string, excludeFrom?: string) {
    const rows = excludeFrom
      ? this.sql.exec("SELECT * FROM messages WHERE seq > ? AND from_id != ? ORDER BY seq LIMIT ?", since, excludeFrom, limit).toArray()
      : this.sql.exec("SELECT * FROM messages WHERE seq > ? ORDER BY seq LIMIT ?", since, limit).toArray();
    return rows.map((r) => this.toMsg(r, room));
  }
  private memberCount() {
    return Number(this.sql.exec("SELECT COUNT(*) AS n FROM members WHERE revoked = 0 AND status = 'active'").one().n);
  }

  // ---------- join requests ----------

  /** Requests an owner can still act on, oldest first. `for_same_invite` above 1 means several
   *  clients knocked with one invite: at most one of them is the person the owner invited. */
  private liveRequests(): JoinRequest[] {
    const now = Date.now();
    const rows = this.sql.exec(
      "SELECT k.code, k.via, k.created AS asked, k.expires, m.id, m.name, m.kind, m.role FROM knocks k JOIN members m ON m.id = k.member_id WHERE k.state = 'waiting' AND k.expires > ? AND m.revoked = 0 AND m.status = 'pending' ORDER BY k.created", now
    ).toArray();
    return rows.map((r) => ({
      member: this.toMember(r), code: r.code as string, via: r.via as string, asked_at: Number(r.asked),
      expires_in_s: Math.ceil((Number(r.expires) - now) / 1000), for_same_invite: rows.filter((x) => x.id === r.id).length
    }));
  }
  private ttlMs() {
    return (Number(this.env.PAIRING_TTL_S) || LIMITS.pairingTtlS) * 1000;
  }

  /** Knock with an unapproved invite: a new join request for this one client. Every knock is its own
   *  request with its own code, and `client_secret` is returned here and never again (only its hash is
   *  kept). A room holds at most LIMITS.maxRequests waiting requests, so the owner's list stays short. */
  async knock(hash: string, via: string) {
    const room = this.roomId();
    const r = this.row(hash);
    if (r.status !== "pending") throw new RelayError("bad_request", "this token is already approved; connect with it directly");
    const secret = newSecret(room);
    const secretHash = await hashToken(secret);
    const now = Date.now();
    this.sql.exec("DELETE FROM knocks WHERE expires <= ?", now);
    // One invite holds at most LIMITS.maxPerInvite waiting requests; a further knock is refused until one
    // is answered or expires. Without this, whoever holds a single invite could fill the room's whole
    // list and lock every other invitee out. (Refused rather than replacing the oldest, so a second
    // holder of a leaked invite cannot push the real invitee's waiting request out.)
    const own = Number(this.sql.exec("SELECT COUNT(*) AS n FROM knocks WHERE member_id = ? AND state = 'waiting'", r.id).one().n);
    if (own >= LIMITS.maxPerInvite) throw new RelayError("rate_limited", `this invite already has ${LIMITS.maxPerInvite} join requests waiting; ask the room owner to answer them, or wait for them to expire`);
    const live = this.sql.exec("SELECT code, state FROM knocks").toArray();
    if (live.filter((k) => k.state === "waiting").length >= LIMITS.maxRequests) throw new RelayError("rate_limited", `this room already has ${LIMITS.maxRequests} join requests waiting for its owner; try again in a few minutes`);
    let code = pairingCode();
    while (live.some((k) => k.code === code)) code = pairingCode(); // the owner approves by code, so no two alike
    const id = randomId();
    this.sql.exec("INSERT INTO knocks (id, member_id, secret_hash, code, via, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?)", id, r.id, secretHash, code, via, now, now + this.ttlMs());
    this.tellOwners();
    return { request_id: id, client_secret: secret, code, expires_in_s: Math.ceil(this.ttlMs() / 1000), name: r.name as string };
  }

  /** A knocking client asks about its own request, named by the hash of its secret; nobody else can.
   *  Waits up to timeoutS for the owner. Ends "approved", "waiting" (timed out, code still good),
   *  "expired" (also for a secret that matches nothing), or with a denied error. */
  async claim(secretHash: string, timeoutS: number, mode: ClaimMode): Promise<Claim> {
    this.roomId();
    const q = this.sql.exec("SELECT * FROM knocks WHERE secret_hash = ? AND expires > ?", secretHash, Date.now()).toArray()[0];
    if (!q) return { state: "expired" };
    if (q.state === "denied") throw new RelayError("revoked", DENIED);
    if (q.state === "approved") return this.finish(q.id as string, mode);
    const expires = Number(q.expires);
    const waiting = (): Claim => ({ state: "waiting", code: q.code as string, expires_in_s: Math.max(0, Math.ceil((expires - Date.now()) / 1000)) });
    const ms = Math.max(0, Math.min(LIMITS.maxWaitS, timeoutS)) * 1000;
    if (!ms) return waiting();
    const left = expires - Date.now();
    return new Promise<Claim>((resolve, reject) => {
      const k: Knocker = {
        reqId: q.id as string, mode, resolve, reject,
        timer: setTimeout(() => {
          this.knockers.delete(k);
          resolve(left <= ms ? { state: "expired" } : waiting());
        }, Math.min(ms, Math.max(0, left)))
      };
      this.knockers.add(k);
    });
  }

  /** Hand an approved request's result to its client. "token" mints the member's token now, so it
   *  exists in plain text only in this one reply; the request is then gone, so it works once. */
  private async finish(reqId: string, mode: ClaimMode): Promise<Claim> {
    const token = mode === "token" ? newToken(this.roomId()) : null;
    const hash = token ? await hashToken(token) : null;
    // No await below: check and use up the request in one step.
    const q = this.sql.exec("SELECT m.* FROM knocks k JOIN members m ON m.id = k.member_id WHERE k.id = ? AND k.state = 'approved' AND k.expires > ? AND m.revoked = 0", reqId, Date.now()).toArray()[0];
    if (!q) return { state: "expired" };
    const member = this.toMember(q);
    if (mode === "peek") return { state: "approved", member };
    this.sql.exec("DELETE FROM knocks WHERE id = ?", reqId);
    if (hash) this.sql.exec("UPDATE members SET token_hash = ? WHERE id = ?", hash, member.id);
    this.seen.set(member.id, Date.now());
    return { state: "approved", member, ...(token ? { token } : {}) };
  }

  /** Deny requests: their clients' open polls and sockets end now, and later polls say denied. */
  private shut(reqIds: string[]) {
    if (!reqIds.length) return;
    const ids = new Set(reqIds);
    for (const id of ids) this.sql.exec("UPDATE knocks SET state = 'denied' WHERE id = ?", id);
    for (const k of [...this.knockers]) {
      if (ids.has(k.reqId)) {
        this.knockers.delete(k);
        clearTimeout(k.timer);
        k.reject(new RelayError("revoked", DENIED));
      }
    }
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a?.req && ids.has(a.req)) {
        try { ws.send(JSON.stringify({ t: "error", code: "revoked", denied: true, message: DENIED })); } catch { /* closed */ }
        ws.close(4001, "denied");
      }
    }
  }

  /** Push the current join requests to every owner's open web view. */
  private tellOwners() {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const owners = new Set(this.sql.exec("SELECT id FROM members WHERE role = 'owner' AND revoked = 0 AND status = 'active'").toArray().map((r) => r.id as string));
    const frame = JSON.stringify({ t: "requests", requests: this.liveRequests() });
    for (const ws of sockets) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a?.mid && owners.has(a.mid)) try { ws.send(frame); } catch { /* closed */ }
    }
  }

  /** The request an owner named by its pairing code ("482 913", "482913" and "482-913" all match). */
  private findRequest(code: string) {
    const digits = String(code ?? "").replace(/\D/g, "");
    const q = this.sql.exec("SELECT k.id AS req, k.code, m.id, m.name, m.kind, m.role FROM knocks k JOIN members m ON m.id = k.member_id WHERE k.state = 'waiting' AND k.expires > ? AND m.revoked = 0 AND m.status = 'pending'", Date.now())
      .toArray().find((x) => (x.code as string).replace(/\D/g, "") === digits);
    if (!q) throw new RelayError("not_found", "no waiting request has that pairing code. Codes expire; the requester has to ask again for a new one");
    return { reqId: q.req as string, member: this.toMember(q) };
  }

  async requests(who: string) {
    this.owner(who, "see join requests");
    return this.liveRequests();
  }

  /** Approve one request by its pairing code. The member becomes active, but the invite they came
   *  with is used up: its hash moves to used_invite, and the member has no working token until the
   *  approved client collects one (or finishes the connector sign-in). Every other request made
   *  with the same invite is denied, so a second holder of the invite gets nothing. */
  async approve(who: string, code: string) {
    const m = this.owner(who, "approve");
    const q = this.findRequest(code);
    const id = q.member.id, now = Date.now();
    this.sql.exec("UPDATE members SET status = 'active', approved_by = ?, approved_at = ?, used_invite = token_hash, token_hash = ? WHERE id = ?", m.id, now, `unclaimed:${id}`, id);
    this.sql.exec("UPDATE knocks SET state = 'approved', expires = ? WHERE id = ?", now + this.ttlMs(), q.reqId); // the client has one more lifetime to collect
    this.shut(this.sql.exec("SELECT id FROM knocks WHERE member_id = ? AND id != ?", id, q.reqId).toArray().map((r) => r.id as string));
    this.post(m, { text: `Owner ${m.name} approved ${q.member.name}`, type: "status" });
    for (const k of [...this.knockers]) {
      if (k.reqId === q.reqId) {
        this.knockers.delete(k);
        clearTimeout(k.timer);
        this.finish(q.reqId, k.mode).then(k.resolve, k.reject);
      }
    }
    // A waiting web view answers this frame with its secret and gets its token.
    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment() as Attach | null)?.req === q.reqId) try { ws.send('{"t":"approved"}'); } catch { /* closed */ }
    }
    this.tellOwners();
    return { member: q.member, approved_by: m.name, approved_at: now };
  }

  /** Deny is for a request the owner did not expect, which means the invite got out: the invite is
   *  revoked and every request made with it ends. (To pick between two requests, approve the right one.) */
  async deny(who: string, code: string) {
    this.owner(who, "deny");
    const q = this.findRequest(code);
    this.kick(q.member.id);
    return { member: q.member };
  }

  /** Revoke a member or an invite now: the token stops working, and open waits, requests and sockets end. */
  private kick(id: string) {
    this.sql.exec("UPDATE members SET revoked = 1 WHERE id = ?", id);
    this.shut(this.sql.exec("SELECT id FROM knocks WHERE member_id = ?", id).toArray().map((r) => r.id as string));
    for (const w of [...this.waiters]) {
      if (w.memberId === id) {
        this.waiters.delete(w);
        clearTimeout(w.timer);
        w.reject(new RelayError("revoked", REVOKED));
      }
    }
    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment() as Attach | null)?.mid === id) ws.close(4001, "revoked");
    }
    this.tellOwners();
  }

  // ---------- setup & auth ----------

  /** Create the room with its first owner. Only works once per room id. */
  async init(room: string, name: string, owner: { name: string; kind: Kind }) {
    if (this.meta("room")) throw new RelayError("bad_request", "room already exists");
    this.sql.exec("INSERT INTO meta (k, v) VALUES ('room', ?), ('name', ?), ('created', ?)", room, name, String(Date.now()));
    const token = newToken(room);
    const id = randomId();
    owner = { ...owner, name: cleanName(owner.name) || "Owner" };
    // The first owner is active from the start: there is nobody else to approve them.
    this.sql.exec("INSERT INTO members (id, name, kind, role, token_hash, created, status) VALUES (?, ?, ?, 'owner', ?, ?, 'active')", id, owner.name, owner.kind, await hashToken(token), Date.now());
    return { room, name, owner_token: token, member: { id, name: owner.name, kind: owner.kind, role: "owner" as Role } };
  }

  /** Test hook, local only (needs TEST_HOOKS, which the live Worker never has). It builds a brand-new
   *  room the way rooms were stored before owner approval existed (members without the new columns,
   *  no knocks table), then runs the same migration a deploy would. It refuses any room that
   *  already exists, so it cannot touch real data. */
  async initLegacy(room: string, name: string) {
    if (!this.env.TEST_HOOKS) throw new RelayError("forbidden", "test hooks are off");
    if (this.meta("room")) throw new RelayError("bad_request", "room already exists");
    this.sql.exec(`
      DROP TABLE knocks; DROP TABLE members;
      CREATE TABLE members (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, role TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, invited_by TEXT);
    `);
    this.sql.exec("INSERT INTO meta (k, v) VALUES ('room', ?), ('name', ?), ('created', ?)", room, name, String(Date.now()));
    const tokens: Record<string, string> = {};
    for (const [who, role, revoked] of [["Old Owner", "owner", 0], ["Old Member", "member", 0], ["Old Gone", "member", 1]] as const) {
      tokens[who] = newToken(room);
      this.sql.exec("INSERT INTO members (id, name, kind, role, token_hash, created, revoked) VALUES (?, ?, 'agent', ?, ?, ?, ?)", randomId(), who, role, await hashToken(tokens[who]), Date.now(), revoked);
    }
    const columns = () => this.sql.exec("PRAGMA table_info(members)").toArray().map((r) => r.name as string);
    const before = columns();
    this.migrate();
    this.migrate(); // a second run must change nothing
    return { room, owner_token: tokens["Old Owner"], member_token: tokens["Old Member"], revoked_token: tokens["Old Gone"], columns_before: before, columns_after: columns() };
  }

  /** Token → the member, with `invite` set if it is an invite the owner has not approved yet (which
   *  gives no access: the caller has to knock). Null if unknown or revoked. */
  async access(hash: string): Promise<{ member: Member; invite?: boolean } | null> {
    if (!this.meta("room") || this.meta("deleted")) return null;
    const r = this.sql.exec("SELECT * FROM members WHERE token_hash = ? AND revoked = 0", hash).toArray()[0];
    if (!r) return null;
    const member = this.toMember(r);
    if (r.status === "pending") return { member, invite: true };
    this.seen.set(member.id, Date.now());
    return { member };
  }

  /** For /mcp's bearer check: "ok", "revoked" (let it through so every tool returns a clear revoked message), or null.
   *  An unapproved or used-up invite is let through too, so each tool can say what to do instead. */
  async tokenStatus(hash: string): Promise<"ok" | "revoked" | null> {
    if (!this.meta("room") || this.meta("deleted")) return null;
    const r = this.sql.exec("SELECT revoked, token_hash FROM members WHERE token_hash = ? OR used_invite = ?", hash, hash).toArray()[0];
    return !r ? null : r.revoked && r.token_hash === hash ? "revoked" : "ok";
  }

  /** A member cannot take a name any other member has or had (revoked ones too: their old messages
   *  stay in the room under that name), so nobody can pose as someone else. */
  private assertNameFree(name: string, exceptId: string | null) {
    const problem = nameProblem(name);
    if (problem) throw new RelayError("bad_request", problem);
    const key = nameKey(name);
    // Current names of every member, plus every name a message in the room was ever sent under.
    const rows = this.sql.exec("SELECT id, name FROM members UNION SELECT DISTINCT from_id AS id, from_name AS name FROM messages").toArray() as { id: string; name: string }[];
    if (rows.some((r) => r.id !== exceptId && nameKey(String(r.name)) === key)) {
      throw new RelayError("bad_request", `the name "${name}" is already used in this room; pick another`);
    }
  }

  async join(who: string, displayName?: string) {
    let m = this.me(who);
    const memberId = m.id;
    const name = cleanName(displayName);
    if (name && name !== m.name) {
      this.assertNameFree(name, memberId);
      this.sql.exec("UPDATE members SET name = ? WHERE id = ?", name, memberId);
      m = { ...m, name };
    }
    return { member: m, room: { id: this.roomId(), name: this.meta("name"), members: this.memberCount() }, last_seq: this.lastSeq() };
  }

  // ---------- messages ----------

  async send(who: string, input: { text: string; type?: string; to?: string | null; reply_to?: number | null; client_id?: string | null }) {
    const m = this.me(who);
    const memberId = m.id;
    if (m.role === "read-only") throw new RelayError("forbidden", "read-only members can't post");
    const text = String(input.text ?? "");
    if (!text.trim()) throw new RelayError("bad_request", "text is empty");
    if (text.length > LIMITS.maxText) throw new RelayError("bad_request", `text is over ${LIMITS.maxText} characters`);
    const type = (input.type ?? "chat") as MsgType;
    if (!TYPES.includes(type)) throw new RelayError("bad_request", `type must be one of ${TYPES.join(", ")}`);
    const clientId = input.client_id ? String(input.client_id).slice(0, 80) : null;
    if (clientId) {
      const dup = this.sql.exec("SELECT seq, ts FROM messages WHERE from_id = ? AND client_id = ?", memberId, clientId).toArray()[0];
      if (dup) return { seq: Number(dup.seq), ts: Number(dup.ts), duplicate: true };
    }
    const now = Date.now();
    const recent = (this.sent.get(memberId) ?? []).filter((t) => now - t < 60_000);
    const perMinute = Number(this.env.RATE_PER_MINUTE) || LIMITS.perMinute;
    if (recent.length >= perMinute) throw new RelayError("rate_limited", `max ${perMinute} messages a minute; slow down`);
    recent.push(now);
    this.sent.set(memberId, recent);
    const replyTo = input.reply_to == null ? null : Number(input.reply_to);
    return { ...this.post(m, { text, type, to: cleanName(input.to) || null, reply_to: replyTo, client_id: clientId }), duplicate: false };
  }

  /** Write one message from a member and push it to everyone listening. */
  private post(m: Member, p: { text: string; type: MsgType; to?: string | null; reply_to?: number | null; client_id?: string | null }) {
    const room = this.roomId();
    const id = randomId(), now = Date.now();
    const to = p.to ?? null, replyTo = p.reply_to ?? null;
    const seq = Number(
      this.sql.exec(
        "INSERT INTO messages (id, from_id, from_name, from_kind, to_name, type, text, reply_to, client_id, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq",
        id, m.id, m.name, m.kind, to, p.type, p.text, replyTo, p.client_id ?? null, now
      ).one().seq
    );
    if (seq % 100 === 0) this.sql.exec("DELETE FROM messages WHERE seq <= ?", seq - LIMITS.keep);
    this.fanout({ id, seq, room, from: { id: m.id, name: m.name, kind: m.kind }, to, type: p.type, text: p.text, reply_to: replyTo, ts: now });
    return { seq, ts: now };
  }

  /** Push one new message to every waiter and socket, right away. Knocking clients are in neither
   *  list: their long-polls sit in `knockers` and their sockets carry `req`, not `mid`. */
  private fanout(msg: Msg) {
    for (const w of [...this.waiters]) {
      if (msg.seq > w.since && msg.from.id !== w.memberId) {
        this.waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve({ messages: this.since(w.since, LIMITS.readMax, msg.room, w.memberId), last_seq: msg.seq, timed_out: false, me: w.memberId });
      }
    }
    const frame = JSON.stringify({ t: "msg", m: msg });
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a?.mid) try { ws.send(frame); } catch { /* closed */ }
    }
  }

  async read(who: string, since: number, limit = 50) {
    const me = this.me(who).id;
    const room = this.roomId();
    const n = Math.max(1, Math.min(LIMITS.readMax, Math.floor(limit) || 50));
    // since < 0 means "the latest n" (handy for a first look).
    const from = since < 0 ? Math.max(0, this.lastSeq() - n) : since;
    return { messages: this.since(from, n, room), last_seq: this.lastSeq(), me };
  }

  /** Long-poll: returns as soon as someone else posts after `since`, or empty at the timeout. */
  async wait(who: string, since: number, timeoutS: number): Promise<WaitResult> {
    const memberId = this.me(who).id;
    const room = this.roomId();
    const ready = this.since(since, LIMITS.readMax, room, memberId);
    if (ready.length) return { messages: ready, last_seq: this.lastSeq(), timed_out: false, me: memberId };
    const ms = Math.max(0, Math.min(LIMITS.maxWaitS, timeoutS)) * 1000;
    if (!ms) return { messages: [], last_seq: this.lastSeq(), timed_out: true, me: memberId };
    return new Promise<WaitResult>((resolve, reject) => {
      const w: Waiter = {
        memberId, since, resolve, reject,
        timer: setTimeout(() => {
          this.waiters.delete(w);
          resolve({ messages: [], last_seq: this.lastSeq(), timed_out: true, me: memberId });
        }, ms)
      };
      this.waiters.add(w);
    });
  }

  async members(who: string) {
    const memberId = this.me(who).id;
    const now = Date.now();
    const live = new Set<string>([...this.waiters].map((w) => w.memberId));
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a?.mid) live.add(a.mid);
    }
    return this.sql.exec("SELECT * FROM members WHERE revoked = 0 ORDER BY created").toArray().map((r) => {
      const m = this.toMember(r);
      const seen = this.seen.get(m.id) ?? null;
      return {
        ...m, status: r.status as "pending" | "active", approved_by: (r.approved_by as string) ?? null, approved_at: r.approved_at == null ? null : Number(r.approved_at),
        you: m.id === memberId, online: live.has(m.id) || (seen != null && now - seen < 90_000), waiting: live.has(m.id), last_seen: seen
      };
    });
  }

  // ---------- owners ----------

  /** A new member. By default the token returned is an invite: a one-time ticket the invitee knocks
   *  with, and the owner approves by pairing code. `approved` returns a member token that works at
   *  once (for the owner's own agents). */
  async invite(who: string, name: string, role: string, kind: string, approved = false) {
    const m = this.owner(who, "invite");
    if (!ROLES.includes(role as Role)) throw new RelayError("bad_request", `role must be one of ${ROLES.join(", ")}`);
    if (!KINDS.includes(kind as Kind)) throw new RelayError("bad_request", `kind must be agent or human`);
    const clean = cleanName(name);
    if (!clean) throw new RelayError("bad_request", "display_name is empty");
    this.assertNameFree(clean, null);
    const room = this.roomId();
    const token = newToken(room);
    const id = randomId(), now = Date.now();
    this.sql.exec(
      "INSERT INTO members (id, name, kind, role, token_hash, created, invited_by, status, approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, clean, kind, role, await hashToken(token), now, m.id, approved ? "active" : "pending", approved ? m.id : null, approved ? now : null
    );
    return { invite_token: token, member: { id, name: clean, kind: kind as Kind, role: role as Role }, status: approved ? ("active" as const) : ("pending" as const) };
  }

  async revoke(who: string, targetId: string) {
    this.owner(who, "revoke");
    const t = this.sql.exec("SELECT * FROM members WHERE id = ? AND revoked = 0", targetId).toArray()[0];
    if (!t) throw new RelayError("not_found", "no such active member");
    this.kick(targetId);
    return { ok: true };
  }

  async info() {
    return { id: this.roomId(), name: this.meta("name"), last_seq: this.lastSeq(), members: this.memberCount() };
  }

  // ---------- WebSocket (web view / phone) ----------

  async fetch(request: Request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    try { this.roomId(); } catch { return new Response("no such room", { status: 404 }); }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({} satisfies Attach);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let f: { t?: string; token?: string; secret?: string; since?: number; text?: string; type?: string; to?: string; reply_to?: number; client_id?: string; ref?: string; code?: string };
    try { f = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return; }
    const reply = (o: object) => { try { ws.send(JSON.stringify(o)); } catch { /* closed */ } };
    const a = (ws.deserializeAttachment() as Attach | null) ?? {};
    const needMember = () => reply({ t: "error", ref: f.ref ?? null, code: a.req ? "pending" : "unauthorized", message: a.req ? "waiting for the owner's approval" : "auth first" });
    try {
      if (f.t === "auth") {
        const hash = await hashToken(String(f.token ?? ""));
        const who = await this.access(hash);
        if (!who) { reply({ t: "error", code: "unauthorized", message: "bad or revoked token" }); ws.close(4001, "unauthorized"); return; }
        if (who.invite) {
          // An invite: this socket knocks. It stays open with no room content and hears "approved" or "denied".
          const k = await this.knock(hash, "web view");
          ws.serializeAttachment({ req: k.request_id } satisfies Attach);
          return reply({ t: "pending", name: k.name, code: k.code, expires_in_s: k.expires_in_s, secret: k.client_secret });
        }
        const m = who.member;
        ws.serializeAttachment({ mid: m.id } satisfies Attach);
        const room = this.roomId();
        const since = typeof f.since === "number" && f.since >= 0 ? f.since : Math.max(0, this.lastSeq() - 50);
        reply({ t: "hello", member: m, room: { id: room, name: this.meta("name") }, messages: this.since(since, LIMITS.readMax, room), last_seq: this.lastSeq(), ...(m.role === "owner" ? { requests: this.liveRequests() } : {}) });
      } else if (f.t === "claim") {
        // A page that knocked earlier (it kept its secret) comes back for its request: after a reload, or on "approved".
        const secretHash = await hashToken(String(f.secret ?? ""));
        const c = await this.claim(secretHash, 0, "token");
        if (c.state === "approved") return reply({ t: "token", token: c.token });
        if (c.state === "expired") return reply({ t: "error", code: "expired", message: "that pairing code expired" });
        const q = this.sql.exec("SELECT id FROM knocks WHERE secret_hash = ?", secretHash).toArray()[0];
        ws.serializeAttachment({ req: q?.id as string } satisfies Attach);
        reply({ t: "pending", code: c.code, expires_in_s: c.expires_in_s });
      } else if (f.t === "send") {
        if (!a.mid) return needMember();
        const r = await this.send(a.mid, { text: f.text ?? "", type: f.type, to: f.to, reply_to: f.reply_to, client_id: f.client_id });
        reply({ t: "sent", ref: f.ref ?? null, ...r });
      } else if (f.t === "approve" || f.t === "deny") {
        if (!a.mid) return needMember();
        const r = f.t === "approve" ? await this.approve(a.mid, String(f.code ?? "")) : await this.deny(a.mid, String(f.code ?? ""));
        reply({ t: "done", ref: f.ref ?? null, did: f.t, name: r.member.name });
      } else if (f.t === "ping") {
        if (a.mid) this.seen.set(a.mid, Date.now());
        reply({ t: "pong", ref: f.ref ?? null, ...(a.mid ? { last_seq: this.lastSeq() } : {}) });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      reply({ t: "error", ref: f.ref ?? null, code: /^(\w+):/.exec(message)?.[1] ?? "error", message });
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch { /* already closed */ }
  }
}
