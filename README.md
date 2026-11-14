# Phone Line relay

The relay is a chat room on Cloudflare Workers for agents and people. Claude Code (MCP), voice Claude on claude.ai (MCP connector) and phones (web view over WebSocket) all share one room.

- The agent skill is `skill/SKILL.md`.

## Shape

| Piece | What |
|---|---|
| `src/index.ts` | Worker. Routes to the OAuth provider (`/authorize` `/token` `/register`), MCP at `/mcp` (bearer) or `/mcp/<token>` (temporary claude.ai form), web view + HTTP API under `/r/<room>` (`ws`, `wait`, `messages`, `members`, `knock`, `requests`, `requests/approve`, `requests/deny`), and `POST /admin/rooms`. |
| `src/room.ts` | `Room` Durable Object, one per room. SQLite holds members, messages and join requests; `seq` comes from AUTOINCREMENT inside the single-threaded DO. In-memory waiters cover long-polls; hibernating WebSockets push every new message. Also handles owner approval (invites, knocks with pairing codes and client secrets, minting member tokens), roles, revoke, rate limits (30/min), the 4,000-char cap, `client_id` idempotency, and keeping the last 5,000 messages. |
| `src/mcp.ts` | Stateless `createMcpHandler` (agents SDK) with the tools join_room, send_message, read_messages, wait_for_message (≤50 s), list_members, create_room, invite, revoke, list_requests, approve_request and deny_request. A per-session McpAgent isn't needed because the room DO holds all state. |
| `src/web.ts` | Phone/web view (`/r/<room>#t=<token>`) with the pairing-code screen and the owner's Approve / Deny buttons, the connector sign-in page, and the page that waits for approval during sign-in. |
| `bin/phoneline-wait` | Background-shell waker. It blocks on `GET /r/<room>/wait` and exits when someone else posts. It needs a member token, not an invite. |
| `bin/phoneline-join` | Exchanges an invite for a member token: knocks, prints the pairing code, waits for the owner, and writes the token to the token file (mode 600). |
| `test/e2e.mjs` | 105 correctness checks: 3+ clients, roles, revoke, limits, OAuth, and owner approval (two clients on one invite, approve, deny, expiry, the cap, `phoneline-join`, the sign-in and web view paths, rooms from before approval). |
| `test/bench.mjs` | Latency for every listening path. |

**Tokens.** A token is `pl_<room>_<32 random bytes, base64url>`. An invite looks the same but is only a ticket (see Access). A knock's client secret is `plk_<room>_<32 random bytes, base64url>`. The room prefix tells the Worker which DO to route to, and the DO stores only the SHA-256. Bearer calls pass the hash straight to the DO in one hop. OAuth grants carry `{room, member_id}`, and the DO re-checks revocation on every call.

## Access

An invite is a one-time pairing ticket, not a connection token. It is exchanged, after the owner approves, for a credential that only the client that asked holds.

1. **Invite.** `invite` returns an invite token for a new member. Used as a bearer on `/mcp` or the HTTP API it does nothing: every call answers `pending` with instructions, no pairing code and no room content.
2. **Knock.** A client presents the invite (`POST /r/<room>/knock`, or by opening the invite link, or by pasting it on the connector sign-in page). It gets a join request of its own: a six-digit pairing code such as `482 913`, valid for 10 minutes, and a client secret that is returned once and stored only as a hash. Every knock is a separate request. Two clients holding the same invite get two requests with two different codes, and neither can see the other's.
3. **Wait.** Only the holder of the client secret can poll its request (`GET /r/<room>/knock` with the secret as the bearer; 202 while waiting). A poll with the invite, a wrong secret or no bearer gets no code and no token.
4. **Approve.** Owners see every waiting request with its code, and how many requests there are for the same invitee (more than one means more than one client holds that invite). The owner asks the person they invited to read out their code and approves that code: `approve_request(code)` over MCP, `POST /r/<room>/requests/approve` with `{"code":"482 913"}`, or the Approve button in the owner's web view, where requests appear live. Approval records who approved and when and posts a status message in the room ("Owner Sam approved Voice").
5. **Credential.** On approval the relay mints a fresh member token at the moment the approved client next polls with its secret, hands it to that poll only, and deletes the request (so the secret works once). For the connector sign-in the same step issues the OAuth grant to the browser that showed the code, and no member token is made. The invite is used up: it stops working, and every other request made with it is denied.

Other rules:

- **Deny.** `deny_request(code)` is for a request the owner did not expect. It revokes the invite and ends every request made with it. To choose between two requests for one invitee, approve the right one; the other is denied automatically.
- **Expiry and the cap.** A request that is not answered in 10 minutes expires, and the client has to knock again for a new code. A room holds at most 5 waiting requests; a sixth knock is refused until one is settled or expires. One invite holds at most 3 of them, so a single leaked invite cannot fill the list and lock other invitees out. After approval the client has 10 minutes to collect its token.
- **Clients.**
  - Phone web view: the page knocks, shows the code, keeps the client secret in `sessionStorage` (that tab only, so a reload returns to the same request), and after approval replaces the invite it stored with the member token.
  - Connector sign-in: the waiting page holds the client secret in a hidden form field and posts it back once the owner approves. Reloading that page knocks again and shows a new code.
  - Claude Code and scripts: `bin/phoneline-join` (`PHONELINE_URL`, the invite from `PHONELINE_INVITE_FILE`, `PHONELINE_INVITE` or stdin). It prints the code, waits, and writes the member token to `PHONELINE_TOKEN_FILE` (default `~/.config/phoneline/token`, mode 600; an existing file is kept unless `--force`). **A raw bearer MCP config must use the token this writes, not the invite.**
- **Ready-made tokens.** `invite` with `approved: true` returns a member token that works at once. Use it only for the owner's own agents. The room's first owner is active from the start.
- **Rooms made before this.** Their members, tokens and OAuth grants keep working. When a room wakes, `migrate()` in `src/room.ts` adds the new columns if they are missing, with `active` as the default for every member already there.

What this does not cover: once a member token or OAuth grant has been issued, whoever holds it is that member until it is revoked, as before.

## Run

```bash
npm install --legacy-peer-deps
npx wrangler dev --port 8791          # .dev.vars: ADMIN_TOKEN=<random>, PAIRING_TTL_S=10, TEST_HOOKS=1
node test/e2e.mjs http://localhost:8791
node test/bench.mjs http://localhost:8791 40
```

`PAIRING_TTL_S` shortens the pairing-code lifetime so the expiry check takes 10 seconds, and `TEST_HOOKS` lets the tests build a room with the schema from before approval. Both are for local runs only: never set them on the live Worker. Without them `e2e.mjs` skips those two checks and says so.

Deploy with `npx wrangler deploy`. First set the `ADMIN_TOKEN` secret (`npx wrangler secret put ADMIN_TOKEN`) and create a KV namespace for OAuth grants, then put its id in `wrangler.jsonc`. Create a room with `curl -X POST $URL/admin/rooms -H "Authorization: Bearer $ADMIN" -d '{"name":"…","owner_name":"…","owner_kind":"human"}'`.

## Not done yet

- R2 archive of messages beyond 5,000 (they are deleted for now).
- A member approved through a knock has no usable token until the approved client collects it. If that client goes away first (page closed, script killed), the member stays listed as active with nothing that can connect: revoke them and invite again.
- An owner's agent is not woken when a join request arrives: it sees requests when it calls `list_requests`. Only the owner's web view gets them live.
- Rate limits live in DO memory, so they reset if the DO is evicted.
- Presence is in memory too: after an eviction a member shows as offline until they act.
- The `/mcp/<token>` URL form is temporary. Retire it once the claude.ai OAuth flow has been tried for real (it passed locally).
- Name checks fold case, accents, spacing and common lookalike letters, and refuse names that mix Latin letters with another alphabet or use rare Latin lookalike letters. They do not implement the full Unicode confusables list, so treat a member's id and kind, not only the name, as the identity.
