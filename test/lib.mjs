// Test helpers: admin bootstrap, MCP clients, WebSocket clients, HTTP calls, the background-curl waiter.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const now = () => performance.timeOrigin + performance.now(); // ms, sub-ms precision

export function adminToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  return /ADMIN_TOKEN=(\S+)/.exec(readFileSync(join(ROOT, ".dev.vars"), "utf8"))[1];
}

export async function createRoom(base, name, owner_name = "Owner", owner_kind = "agent") {
  const r = await fetch(`${base}/admin/rooms`, { method: "POST", headers: { authorization: `Bearer ${adminToken()}` }, body: JSON.stringify({ name, owner_name, owner_kind }) });
  if (!r.ok) throw new Error(`createRoom ${r.status} ${await r.text()}`);
  return r.json();
}

export async function mcp(base, token, name = "test") {
  const client = new Client({ name, version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  const call = async (tool, args = {}) => {
    const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 });
    const text = r.content?.map((c) => c.text).join("\n") ?? "";
    return { text, isError: !!r.isError, lastSeq: Number(/last_seq (\d+)/.exec(text)?.[1] ?? NaN), seq: Number(/seq (\d+)/.exec(text)?.[1] ?? NaN) };
  };
  return { client, call, close: () => client.close() };
}

/** A WebSocket member (the phone / web view protocol). onMsg gets every pushed message. */
export function ws(base, token, onMsg = () => {}) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(`${base.replace(/^http/, "ws")}/r/${roomOf(token)}/ws`);
    const pending = new Map();
    let hello;
    s.onopen = () => s.send(JSON.stringify({ t: "auth", token }));
    s.onerror = (e) => reject(e);
    s.onmessage = (e) => {
      const at = now();
      const f = JSON.parse(e.data);
      if (f.t === "hello") { hello = f; resolve(api); }
      else if (f.t === "msg") onMsg(f.m, at);
      else if ((f.t === "sent" || f.t === "error" || f.t === "pong") && f.ref && pending.has(f.ref)) { pending.get(f.ref)(f); pending.delete(f.ref); }
      else if (f.t === "error" && !hello) reject(new Error(f.message));
    };
    let n = 0;
    const api = {
      socket: s,
      get hello() { return hello; },
      send: (text, extra = {}) => new Promise((res) => { const ref = `r${++n}`; pending.set(ref, res); s.send(JSON.stringify({ t: "send", ref, text, ...extra })); }),
      close: () => s.close()
    };
  });
}

export const roomOf = (token) => token.slice(3).split("_")[0];

export async function http(base, token, path, init = {}) {
  const r = await fetch(`${base}/r/${roomOf(token)}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const ct = r.headers.get("content-type") ?? "";
  return { status: r.status, body: ct.includes("json") ? await r.json() : await r.text(), headers: r.headers };
}

/** Run bin/phoneline-wait the way a Claude Code background shell would. Resolves when the process exits. */
export function curlWait(base, token, since) {
  const started = now();
  const p = spawn(join(ROOT, "bin/phoneline-wait"), [String(since)], { env: { ...process.env, PHONELINE_URL: base, PHONELINE_TOKEN: token } });
  let out = "", err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  const done = new Promise((res) => p.on("exit", (code) => res({ code, out, err, at: now(), started })));
  return { proc: p, done };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function stats(xs) {
  const a = [...xs].sort((x, y) => x - y);
  const q = (p) => a[Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1))];
  const r = (v) => Math.round(v * 10) / 10;
  return { n: a.length, p50: r(q(50)), p95: r(q(95)), max: r(a[a.length - 1]), min: r(a[0]) };
}
