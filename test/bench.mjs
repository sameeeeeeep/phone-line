// Latency bench: send → receive for every path a member can listen on.
// Usage: node test/bench.mjs <base> [iterations]   (ADMIN_TOKEN env or .dev.vars)
// Senders rotate (agent via MCP, phone via WebSocket) so each stays under 30 msgs/min on a real deploy.
import { createRoom, curlWait, mcp, now, sleep, stats, ws } from "./lib.mjs";

const BASE = process.argv[2] ?? "http://localhost:8792";
const N = Number(process.argv[3] ?? 40);
const tok = (text) => /Token \(secret\): (pl_\S+)/.exec(text)?.[1];

const room = await createRoom(BASE, `bench ${new Date().toISOString().slice(11, 16)}`, "Bench", "agent");
const owner = await mcp(BASE, room.owner_token, "bench-owner");
const t = {};
for (const [name, kind] of [["SenderAgent", "agent"], ["SenderPhone", "human"], ["AgentB", "agent"], ["Phone", "human"], ["Curl", "agent"], ["HttpPoll", "agent"], ["Voice", "agent"], ["PathForm", "agent"]])
  t[name] = tok((await owner.call("invite", { display_name: name, role: "member", kind })).text);

const senderAgent = await mcp(BASE, t.SenderAgent, "sender-agent");
const senderPhone = await ws(BASE, t.SenderPhone);
const agentB = await mcp(BASE, t.AgentB, "agent-b");
const voice = await mcp(BASE, t.Voice, "voice");
// The /mcp/<token> form: no header at all.
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const pf = new Client({ name: "pathform", version: "0" });
await pf.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${t.PathForm}`)));

const phoneAt = new Map();
await ws(BASE, t.Phone, (m, at) => phoneAt.set(m.seq, at));

const L = { send_mcp_ack: [], send_ws_ack: [], mcp_wait: [], websocket: [], http_longpoll: [], curl_wake: [] };
let last = 0;
for (let i = 0; i < N; i++) {
  const since = last;
  let bAt, hAt;
  const bP = agentB.call("wait_for_message", { since_seq: since, timeout_s: 30 }).then((r) => { bAt = now(); return r; });
  const hP = fetch(`${BASE}/r/${room.room}/wait?since=${since}&timeout=30`, { headers: { authorization: `Bearer ${t.HttpPoll}` } }).then(async (r) => { hAt = now(); return r.json(); });
  const c = curlWait(BASE, t.Curl, since);
  await sleep(500); // let every listener park on the server
  const t0 = now();
  let seq;
  if (i % 2 === 0) {
    const r = await senderAgent.call("send_message", { text: `bench ${i}`, client_id: `b${i}` });
    L.send_mcp_ack.push(now() - t0); seq = r.seq;
  } else {
    const r = await senderPhone.send(`bench ${i}`, { client_id: `b${i}` });
    L.send_ws_ack.push(now() - t0); seq = r.seq;
  }
  const [b] = await Promise.all([bP, hP]);
  const cr = await c.done;
  if (!new RegExp(`bench ${i}`).test(b.text) || cr.code !== 0) { console.error("miss", i, b.text, cr); continue; }
  await sleep(50);
  L.mcp_wait.push(bAt - t0);
  L.http_longpoll.push(hAt - t0);
  L.curl_wake.push(cr.at - t0);
  if (phoneAt.has(seq)) L.websocket.push(phoneAt.get(seq) - t0);
  last = seq;
  await sleep(700); // stay under 30/min per sender on a real deploy
}

const R = { read_mcp_bearer: [], read_mcp_pathform: [], health_rtt: [] };
for (let i = 0; i < 20; i++) {
  let t0 = now(); await voice.call("read_messages", { since_seq: last }); R.read_mcp_bearer.push(now() - t0);
  t0 = now(); await pf.callTool({ name: "read_messages", arguments: { since_seq: last } }); R.read_mcp_pathform.push(now() - t0);
  t0 = now(); await (await fetch(`${BASE}/health`)).text(); R.health_rtt.push(now() - t0);
}

const out = { base: BASE, at: new Date().toISOString(), iterations: N, from: process.env.BENCH_FROM ?? "mac", ms: {} };
for (const [k, v] of Object.entries({ ...L, ...R })) out.ms[k] = stats(v);
console.log(JSON.stringify(out, null, 2));
for (const c of [owner, senderAgent, agentB, voice]) await c.close().catch(() => {});
await pf.close().catch(() => {});
process.exit(0);
