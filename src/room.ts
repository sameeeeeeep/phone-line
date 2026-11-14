import { DurableObject } from "cloudflare:workers";
import { type Env, type Kind, type Member, type Msg, type MsgType, type Role, LIMITS, RelayError, ROLES, KINDS, TYPES, cleanName, hashToken, mixesAlphabets, nameKey, newToken, randomId } from "./shared";

// One Durable Object per room. It owns the room's SQLite (members + messages), hands out
// seq numbers (the DO runs one request at a time, so seq never collides), and holds the
// waiters: MCP/HTTP long-polls and WebSockets that get each new message the moment it is
// written.

type Waiter = { memberId: string; since: number; resolve: (r: WaitResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
export type WaitResult = { messages: Msg[]; last_seq: number; timed_out: boolean; me: string };
type Attach = { mid?: string };

type Row = Record<string, SqlStorageValue>;

export class Room extends DurableObject<Env> {
  private sql: SqlStorage;
  private waiters = new Set<Waiter>();
  private sent = new Map<string, number[]>(); // member id → send times in the last minute
  private seen = new Map<string, number>(); // member id → last activity (presence)

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, role TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, invited_by TEXT);
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, from_id TEXT NOT NULL, from_name TEXT NOT NULL,
        from_kind TEXT NOT NULL, to_name TEXT, type TEXT NOT NULL, text TEXT NOT NULL, reply_to INTEGER,
        client_id TEXT, ts INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS messages_client ON messages (from_id, client_id) WHERE client_id IS NOT NULL;
    `);
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
  /** The calling member, or a clear error if they were revoked / never existed. */
  /** `who` is a member id (OAuth grants) or a token's sha256 (bearer calls): one DO hop either way. */
  private me(who: string): Member {
    this.roomId();
    const r = (who.length === 64
      ? this.sql.exec("SELECT * FROM members WHERE token_hash = ?", who)
      : this.sql.exec("SELECT * FROM members WHERE id = ?", who)).toArray()[0];
    if (!r) throw new RelayError("unauthorized", "not a member of this room");
    if (r.revoked) throw new RelayError("revoked", "your access to this room was revoked; tell your user and stop polling");
    this.seen.set(r.id as string, Date.now());
    return this.toMember(r);
  }
  private since(since: number, limit: number, room: string, excludeFrom?: string) {
    const rows = excludeFrom
      ? this.sql.exec("SELECT * FROM messages WHERE seq > ? AND from_id != ? ORDER BY seq LIMIT ?", since, excludeFrom, limit).toArray()
      : this.sql.exec("SELECT * FROM messages WHERE seq > ? ORDER BY seq LIMIT ?", since, limit).toArray();
    return rows.map((r) => this.toMsg(r, room));
  }
  private memberCount() {
    return Number(this.sql.exec("SELECT COUNT(*) AS n FROM members WHERE revoked = 0").one().n);
  }

  // ---------- setup & auth ----------

  /** Create the room with its first owner. Only works once per room id. */
  async init(room: string, name: string, owner: { name: string; kind: Kind }) {
    if (this.meta("room")) throw new RelayError("bad_request", "room already exists");
    this.sql.exec("INSERT INTO meta (k, v) VALUES ('room', ?), ('name', ?), ('created', ?)", room, name, String(Date.now()));
    const token = newToken(room);
    const id = randomId();
    owner = { ...owner, name: cleanName(owner.name) || "Owner" };
    this.sql.exec("INSERT INTO members (id, name, kind, role, token_hash, created) VALUES (?, ?, ?, 'owner', ?, ?)", id, owner.name, owner.kind, await hashToken(token), Date.now());
    return { room, name, owner_token: token, member: { id, name: owner.name, kind: owner.kind, role: "owner" as Role } };
  }

  /** Token → member (null if unknown or revoked). The worker calls this on every request. */
  async authHash(hash: string): Promise<Member | null> {
    if (!this.meta("room") || this.meta("deleted")) return null;
    const r = this.sql.exec("SELECT * FROM members WHERE token_hash = ? AND revoked = 0", hash).toArray()[0];
    if (!r) return null;
    this.seen.set(r.id as string, Date.now());
    return this.toMember(r);
  }

  /** For /mcp's bearer check: "ok", "revoked" (let it through so every tool returns a clear revoked message), or null. */
  async tokenStatus(hash: string): Promise<"ok" | "revoked" | null> {
    if (!this.meta("room") || this.meta("deleted")) return null;
    const r = this.sql.exec("SELECT revoked FROM members WHERE token_hash = ?", hash).toArray()[0];
    return !r ? null : r.revoked ? "revoked" : "ok";
  }

  /** A member cannot take a name any other member has or had (revoked ones too: their old messages
   *  stay in the room under that name), so nobody can pose as someone else. */
  private assertNameFree(name: string, exceptId: string | null) {
    if (mixesAlphabets(name)) throw new RelayError("bad_request", "use one alphabet in a display name");
    const key = nameKey(name);
    const rows = this.sql.exec("SELECT id, name FROM members").toArray() as { id: string; name: string }[];
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
    const room = this.roomId();
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

    const id = randomId();
    const to = cleanName(input.to) || null;
    const replyTo = input.reply_to == null ? null : Number(input.reply_to);
    const seq = Number(
      this.sql.exec(
        "INSERT INTO messages (id, from_id, from_name, from_kind, to_name, type, text, reply_to, client_id, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq",
        id, m.id, m.name, m.kind, to, type, text, replyTo, clientId, now
      ).one().seq
    );
    if (seq % 100 === 0) this.sql.exec("DELETE FROM messages WHERE seq <= ?", seq - LIMITS.keep);
    const msg: Msg = { id, seq, room, from: { id: m.id, name: m.name, kind: m.kind }, to, type, text, reply_to: replyTo, ts: now };
    this.fanout(msg);
    return { seq, ts: now, duplicate: false };
  }

  /** Push one new message to every waiter and socket, right away. */
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
      return { ...m, you: m.id === memberId, online: live.has(m.id) || (seen != null && now - seen < 90_000), waiting: live.has(m.id), last_seen: seen };
    });
  }

  // ---------- owners ----------

  async invite(who: string, name: string, role: string, kind: string) {
    const m = this.me(who);
    if (m.role !== "owner") throw new RelayError("forbidden", "only owners can invite");
    if (!ROLES.includes(role as Role)) throw new RelayError("bad_request", `role must be one of ${ROLES.join(", ")}`);
    if (!KINDS.includes(kind as Kind)) throw new RelayError("bad_request", `kind must be agent or human`);
    const clean = cleanName(name);
    if (!clean) throw new RelayError("bad_request", "display_name is empty");
    this.assertNameFree(clean, null);
    const room = this.roomId();
    const token = newToken(room);
    const id = randomId();
    this.sql.exec("INSERT INTO members (id, name, kind, role, token_hash, created, invited_by) VALUES (?, ?, ?, ?, ?, ?, ?)", id, clean, kind, role, await hashToken(token), Date.now(), m.id);
    return { invite_token: token, member: { id, name: clean, kind: kind as Kind, role: role as Role } };
  }

  async revoke(who: string, targetId: string) {
    const m = this.me(who);
    if (m.role !== "owner") throw new RelayError("forbidden", "only owners can revoke");
    const t = this.sql.exec("SELECT * FROM members WHERE id = ? AND revoked = 0", targetId).toArray()[0];
    if (!t) throw new RelayError("not_found", "no such active member");
    this.sql.exec("UPDATE members SET revoked = 1 WHERE id = ?", targetId);
    // Takes effect now: drop their long-polls and sockets.
    for (const w of [...this.waiters]) {
      if (w.memberId === targetId) {
        this.waiters.delete(w);
        clearTimeout(w.timer);
        w.reject(new RelayError("revoked", "your access to this room was revoked; tell your user and stop polling"));
      }
    }
    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment() as Attach | null)?.mid === targetId) ws.close(4001, "revoked");
    }
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
    let f: { t?: string; token?: string; since?: number; text?: string; type?: string; to?: string; reply_to?: number; client_id?: string; ref?: string };
    try { f = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return; }
    const reply = (o: object) => { try { ws.send(JSON.stringify(o)); } catch { /* closed */ } };
    const a = (ws.deserializeAttachment() as Attach | null) ?? {};
    try {
      if (f.t === "auth") {
        const m = await this.authHash(await hashToken(String(f.token ?? "")));
        if (!m) { reply({ t: "error", code: "unauthorized", message: "bad or revoked token" }); ws.close(4001, "unauthorized"); return; }
        ws.serializeAttachment({ mid: m.id } satisfies Attach);
        const room = this.roomId();
        const since = typeof f.since === "number" && f.since >= 0 ? f.since : Math.max(0, this.lastSeq() - 50);
        reply({ t: "hello", member: m, room: { id: room, name: this.meta("name") }, messages: this.since(since, LIMITS.readMax, room), last_seq: this.lastSeq() });
      } else if (f.t === "send") {
        if (!a.mid) return reply({ t: "error", code: "unauthorized", message: "auth first" });
        const r = await this.send(a.mid, { text: f.text ?? "", type: f.type, to: f.to, reply_to: f.reply_to, client_id: f.client_id });
        reply({ t: "sent", ref: f.ref ?? null, ...r });
      } else if (f.t === "ping") {
        if (a.mid) this.seen.set(a.mid, Date.now());
        reply({ t: "pong", ref: f.ref ?? null, last_seq: this.lastSeq() });
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
