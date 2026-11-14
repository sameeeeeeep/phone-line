import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { mcpApi } from "./mcp";
import { authToken, bearer, createRoom, roomStub } from "./rooms";
import { type Env, type Props, KINDS, LIMITS, ROOM_RE, errorCode, hashToken, tokenRoom } from "./shared";
import { authorizePage, roomPage } from "./web";
import type { Msg } from "./shared";

export { Room } from "./room";

// Routes
//   /mcp                       MCP (streamable HTTP). Bearer = relay invite token, or an OAuth token from /authorize.
//   /authorize /token /register OAuth for the claude.ai custom connector (workers-oauth-provider).
//   GET  /r/<room>             live web view (token in the #t= fragment).
//   GET  /r/<room>/ws          WebSocket: {t:auth,token} → hello + every new message; {t:send,…} to post.
//   GET  /r/<room>/wait        HTTP long-poll for a background `curl` that exits on the next message.
//   GET  /r/<room>/messages    read since a seq · POST to send. Bearer token.
//   GET  /r/<room>/members     who's here.
//   POST /admin/rooms          bootstrap a room (ADMIN_TOKEN).

const json = (o: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const err = (e: unknown) => {
  const { code, message, status } = errorCode(e);
  return json({ error: code, message }, status);
};
const nonce = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
const html = (body: string, n: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${n}'; style-src 'nonce-${n}'; connect-src 'self'; base-uri 'none'; form-action 'self' https:; frame-ancestors 'none'`
    }
  });

/** Plain-text lines for a shell: easy for an agent to read when its background curl exits. */
function asText(room: string, r: { messages: Msg[]; last_seq: number }) {
  return r.messages.map((m) => `#${m.seq} [${m.type}] ${m.from.name} (${m.from.kind}) → ${m.to ?? "all"}: ${m.text.replace(/\n/g, "\n    ")}`).join("\n") +
    `\nlast_seq=${r.last_seq} room=${room}\n`;
}

const app = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" || path === "/health") return json({ ok: true, service: "phoneline-relay", t: Date.now() });

    if (path === "/admin/rooms" && request.method === "POST") {
      const t = bearer(request);
      if (!env.ADMIN_TOKEN || !t || t.length !== env.ADMIN_TOKEN.length || !crypto.subtle.timingSafeEqual(new TextEncoder().encode(t), new TextEncoder().encode(env.ADMIN_TOKEN)))
        return json({ error: "unauthorized" }, 401);
      const b = (await request.json().catch(() => ({}))) as { name?: string; owner_name?: string; owner_kind?: string };
      const kind = KINDS.includes(b.owner_kind as never) ? (b.owner_kind as "agent" | "human") : "human";
      try {
        const r = await createRoom(env, String(b.name || "room"), { name: String(b.owner_name || "Owner").slice(0, 60), kind });
        return json({ ...r, web: `${url.origin}/r/${r.room}#t=${r.owner_token}` });
      } catch (e) { return err(e); }
    }

    if (path === "/authorize") return authorize(request, env);

    const m = /^\/r\/([a-z0-9][a-z0-9-]{2,39})(\/(ws|wait|messages|members))?$/.exec(path);
    if (!m) return json({ error: "not_found" }, 404);
    const [, room, , sub] = m;
    if (!ROOM_RE.test(room)) return json({ error: "not_found" }, 404);

    if (!sub) { const n = nonce(); return html(roomPage(room, n), n); }
    if (sub === "ws") return roomStub(env, room).fetch(request);

    // Bearer endpoints: pass the token's hash straight to the room (one DO hop; the DO checks it).
    const t = bearer(request) ?? "";
    if (tokenRoom(t) !== room) return json({ error: "unauthorized", message: "Bearer invite token for this room required" }, 401);
    const who = await hashToken(t);
    const stub = roomStub(env, room);
    try {
      if (sub === "wait") {
        const since = Number(url.searchParams.get("since") ?? -1);
        const timeout = Math.min(LIMITS.maxWaitS, Number(url.searchParams.get("timeout") ?? LIMITS.maxWaitS));
        const r = await stub.wait(who, since < 0 ? (await stub.info()).last_seq : since, timeout);
        if (url.searchParams.get("format") === "text") return new Response(r.timed_out ? "" : asText(room, r), { status: r.timed_out ? 204 : 200, headers: { "content-type": "text/plain; charset=utf-8", "x-last-seq": String(r.last_seq) } });
        return json(r, r.timed_out ? 200 : 200, { "x-last-seq": String(r.last_seq) });
      }
      if (sub === "messages" && request.method === "POST") {
        const b = (await request.json().catch(() => null)) as { text?: string; type?: string; to?: string; reply_to?: number; client_id?: string } | null;
        if (!b) return json({ error: "bad_request", message: "JSON body required" }, 400);
        return json(await stub.send(who, { text: b.text ?? "", type: b.type, to: b.to, reply_to: b.reply_to, client_id: b.client_id }));
      }
      if (sub === "messages") {
        const r = await stub.read(who, Number(url.searchParams.get("since") ?? -1), Number(url.searchParams.get("limit") ?? 50));
        return url.searchParams.get("format") === "text" ? new Response(asText(room, r), { headers: { "content-type": "text/plain; charset=utf-8" } }) : json(r);
      }
      if (sub === "members") return json({ members: await stub.members(who) });
    } catch (e) { return err(e); }
    return json({ error: "not_found" }, 404);
  }
};

type OAuthHelpers = {
  parseAuthRequest(r: Request): Promise<{ clientId: string; redirectUri: string; scope: string[]; state: string } & Record<string, unknown>>;
  lookupClient(id: string): Promise<{ clientName?: string } | null>;
  completeAuthorization(o: { request: unknown; userId: string; metadata: unknown; scope: string[]; props: Props }): Promise<{ redirectTo: string }>;
};

/** The claude.ai connector's sign-in: paste an invite token → an OAuth grant scoped to that member. */
async function authorize(request: Request, env: Env) {
  const oauth = env.OAUTH_PROVIDER as OAuthHelpers;
  const n = nonce();
  let req;
  try { req = await oauth.parseAuthRequest(request); } catch (e) { return html(authorizePage("this app", `Bad sign-in request: ${(e as Error).message}`, n), n, 400); }
  const client = await oauth.lookupClient(req.clientId);
  const name = client?.clientName || "Claude";
  if (request.method !== "POST") return html(authorizePage(name, null, n), n);
  const form = await request.formData();
  const token = String(form.get("token") ?? "").trim().replace(/^.*#t=/, "");
  const who = await authToken(env, token);
  if (!who) return html(authorizePage(name, "That token didn't work. Check it, or ask the room owner for a new invite.", n), n, 401);
  const { redirectTo } = await oauth.completeAuthorization({
    request: req, userId: `${who.room}.${who.member_id}` /* no ':' — the provider splits tokens on it */, metadata: { room: who.room, name: who.member.name }, scope: req.scope,
    props: { room: who.room, member_id: who.member_id }
  });
  return Response.redirect(redirectTo, 302);
}

// Bearer relay tokens on /mcp skip the OAuth KV entirely. A verified token is cached per
// isolate for a minute; the room DO still checks the hash on every tool call, so a revoke
// takes effect on the very next call.
const verified = new Map<string, { room: string; exp: number }>();

const provider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpApi as unknown as ExportedHandler & Pick<Required<ExportedHandler>, "fetch">,
  defaultHandler: app as unknown as ExportedHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  accessTokenTTL: 3600,
  refreshTokenTTL: 90 * 86400,
  async resolveExternalToken({ token, env }) {
    const room = tokenRoom(token);
    if (!room) return null;
    const hash = await hashToken(token);
    const hit = verified.get(hash);
    if (hit && hit.exp > Date.now()) return { props: { room, member_id: hash } satisfies Props };
    const st = await roomStub(env as Env, room).tokenStatus(hash);
    if (!st) return null;
    if (st === "revoked") return { props: { room, member_id: hash } satisfies Props }; // tools answer "revoked, stop"
    if (verified.size > 5000) verified.clear();
    verified.set(hash, { room, exp: Date.now() + 60_000 });
    return { props: { room, member_id: hash } satisfies Props };
  }
});

// TEMPORARY (until claude.ai users go through /authorize): claude.ai custom connectors can't
// send a static header, so /mcp/<token> is accepted too. It is rewritten to /mcp with the
// token as a bearer header, so it gets exactly the same checks. Treat the URL as a secret.
const PATH_TOKEN = /^\/mcp\/(pl_[a-z0-9][a-z0-9-]{2,39}_[A-Za-z0-9_-]{43})\/?$/;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const m = PATH_TOKEN.exec(url.pathname);
    if (m) {
      url.pathname = "/mcp";
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Bearer ${m[1]}`);
      request = new Request(url, { method: request.method, headers, body: request.body, redirect: request.redirect });
    }
    // RFC 9728 protected-resource metadata, so MCP clients (claude.ai) can discover the OAuth server.
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp")
      return Response.json({ resource: `${url.origin}/mcp`, authorization_servers: [url.origin], bearer_methods_supported: ["header"], resource_name: "Phone Line" }, { headers: { "access-control-allow-origin": "*" } });
    const res = await provider.fetch(request, env, ctx);
    if (res.status === 401 && url.pathname.startsWith("/mcp")) {
      const out = new Response(res.body, res);
      out.headers.set("WWW-Authenticate", `Bearer realm="OAuth", error="invalid_token", resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`);
      return out;
    }
    return res;
  }
} satisfies ExportedHandler<Env>;
