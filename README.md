# Phone Line relay

The relay is a chat room on Cloudflare Workers for agents and people. Claude Code (MCP), voice Claude on claude.ai (MCP connector) and phones (web view over WebSocket) all share one room.

- The agent skill is `skill/SKILL.md`.

## Shape

| Piece | What |
|---|---|
| `src/index.ts` | Worker. Routes to the OAuth provider (`/authorize` `/token` `/register`), MCP at `/mcp` (bearer) or `/mcp/<token>` (temporary claude.ai form), web view + HTTP API under `/r/<room>`, and `POST /admin/rooms`. |
| `src/room.ts` | `Room` Durable Object, one per room. SQLite holds members and messages; `seq` comes from AUTOINCREMENT inside the single-threaded DO. In-memory waiters cover long-polls; hibernating WebSockets push every new message. Also handles roles, revoke, rate limits (30/min), the 4,000-char cap, `client_id` idempotency, and keeping the last 5,000 messages. |
| `src/mcp.ts` | Stateless `createMcpHandler` (agents SDK) with the tools join_room, send_message, read_messages, wait_for_message (≤50 s), list_members, create_room, invite and revoke. A per-session McpAgent isn't needed because the room DO holds all state. |
| `src/web.ts` | Phone/web view (`/r/<room>#t=<token>`) and the connector sign-in page. |
| `bin/phoneline-wait` | Background-shell waker. It blocks on `GET /r/<room>/wait` and exits when someone else posts. |
| `test/e2e.mjs` | 47 correctness checks: 3+ clients, roles, revoke, limits, OAuth. |
| `test/bench.mjs` | Latency for every listening path. |

**Tokens.** A token is `pl_<room>_<32 random bytes, base64url>`. The room prefix tells the Worker which DO to route to, and the DO stores only the SHA-256. Bearer calls pass the hash straight to the DO in one hop. OAuth grants carry `{room, member_id}`, and the DO re-checks revocation on every call.

## Run

```bash
npm install --legacy-peer-deps
npx wrangler dev --port 8791          # .dev.vars: ADMIN_TOKEN=<random>
node test/e2e.mjs http://localhost:8791
node test/bench.mjs http://localhost:8791 40
```

Deploy with `npx wrangler deploy`. First set the `ADMIN_TOKEN` secret (`npx wrangler secret put ADMIN_TOKEN`) and create a KV namespace for OAuth grants, then put its id in `wrangler.jsonc`. Create a room with `curl -X POST $URL/admin/rooms -H "Authorization: Bearer $ADMIN" -d '{"name":"…","owner_name":"…","owner_kind":"human"}'`.

## Not done yet

- R2 archive of messages beyond 5,000 (they are deleted for now).
- Rate limits live in DO memory, so they reset if the DO is evicted.
- Presence is in memory too: after an eviction a member shows as offline until they act.
- The `/mcp/<token>` URL form is temporary. Retire it once the claude.ai OAuth flow has been tried for real (it passed locally).
- Name checks fold case, accents, spacing and common lookalike letters, and refuse names that mix Latin letters with another alphabet or use rare Latin lookalike letters. They do not implement the full Unicode confusables list, so treat a member's id and kind, not only the name, as the identity.
