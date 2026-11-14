// HTML for humans: the live room view at /r/<room> and the connector sign-in at /authorize.
// The token lives in the URL fragment (#t=…), never in a query string, so it is never sent
// to the server in a URL or logged; the page keeps it in localStorage for that room.
// An invite link is only a ticket: the page knocks with it, shows the pairing code, keeps the
// request's client secret in sessionStorage (this tab only), and after the owner approves swaps
// the invite for the member token it is handed.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const BASE_CSS = `
:root{--bg:#f6f5f2;--ink:#1b1b1a;--mute:#6b6a66;--line:#e2e0da;--card:#fff;--accent:#1f5eff;--me:#eaf0ff;--warn:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--ink:#ecebe7;--mute:#9a9893;--line:#2c2b29;--card:#1d1d1b;--accent:#7aa2ff;--me:#1d2740;--warn:#ff8a7a}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;-webkit-text-size-adjust:100%}
button,input,select,textarea{font:inherit;color:inherit}
[hidden]{display:none!important}
`;

export function roomPage(room: string, nonce: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><title>${esc(room)} · Phone Line</title>
<style nonce="${nonce}">${BASE_CSS}
.app{display:flex;flex-direction:column;height:100dvh;max-width:760px;margin:0 auto}
header{display:flex;align-items:baseline;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line)}
header h1{font-size:18px;margin:0;font-weight:650}
#state{margin-left:auto;font-size:14px;color:var(--mute)}
#state.live{color:var(--ink)}
#log{flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px}
.m{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px;max-width:92%}
.m.mine{align-self:flex-end;background:var(--me)}
.h{display:flex;gap:8px;flex-wrap:wrap;font-size:14px;color:var(--mute)}
.h b{color:var(--ink);font-weight:600}
.t{white-space:pre-wrap;word-wrap:break-word;margin-top:2px}
.tag{border:1px solid var(--line);border-radius:6px;padding:0 6px;font-size:13px}
.tag.question,.tag.blocked,.tag.decision{border-color:var(--accent);color:var(--accent)}
form{display:flex;gap:8px;padding:10px 16px calc(10px + env(safe-area-inset-bottom));border-top:1px solid var(--line)}
textarea{flex:1;min-height:44px;max-height:160px;resize:none;border:1px solid var(--line);border-radius:10px;padding:10px;background:var(--card)}
select{border:1px solid var(--line);border-radius:10px;background:var(--card);padding:0 6px}
button{border:0;border-radius:10px;background:var(--accent);color:#fff;padding:0 16px;font-weight:600}
.gate{padding:24px 16px}.gate input{width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--card);margin:10px 0}
.gate button{padding:10px 16px}
.code{font-size:34px;font-weight:650;font-variant-numeric:tabular-nums;margin:6px 0 12px}
#reqs{border-bottom:1px solid var(--line)}
.rq{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 16px}
.rq div{flex:1 1 100%}
.rq button{padding:8px 14px}
.rq .no{background:none;color:var(--ink);border:1px solid var(--line)}
.err{color:var(--warn)}
</style></head><body><div class="app">
<header><h1 id="title">${esc(room)}</h1><span id="state">connecting…</span></header>
<div id="reqs" hidden></div>
<div id="log" aria-live="polite"></div>
<form id="f" hidden><select id="type" aria-label="Message type"><option>chat</option><option>question</option><option>decision</option><option>status</option><option>blocked</option><option>done</option></select>
<textarea id="text" rows="1" placeholder="Message the room" maxlength="4000"></textarea><button>Send</button></form>
</div>
<script nonce="${nonce}">
const ROOM=${JSON.stringify(room)},KEY="pl:"+ROOM;
const $=s=>document.querySelector(s),log=$("#log"),state=$("#state");
let tok=null;try{const h=new URLSearchParams(location.hash.slice(1)).get("t");if(h){localStorage.setItem(KEY,h);history.replaceState(null,"",location.pathname)}tok=localStorage.getItem(KEY)}catch(e){tok=new URLSearchParams(location.hash.slice(1)).get("t")}
let me=null,last=-1,ws=null,retry=0,reqs=[],pendTimer=null;const seen=new Set();
const SK="plk:"+ROOM;let sec=null;try{sec=sessionStorage.getItem(SK)}catch(e){}
function setSec(v){sec=v;try{v?sessionStorage.setItem(SK,v):sessionStorage.removeItem(SK)}catch(e){}}
function gate(msg){log.innerHTML='<div class="gate"><p>'+(msg||"Paste your invite link or token to join this room.")+'</p><input id="tk" placeholder="pl_…" autocomplete="off"><button id="go">Join</button></div>';$("#go").onclick=()=>{const v=$("#tk").value.trim();const m=/#t=([^&]+)/.exec(v);tok=m?decodeURIComponent(m[1]):v;try{localStorage.setItem(KEY,tok)}catch(e){};log.innerHTML="";connect()}}
function add(m){if(seen.has(m.seq))return;seen.add(m.seq);last=Math.max(last,m.seq);
const d=document.createElement("div");d.className="m"+(me&&m.from.id===me.id?" mine":"");
const h=document.createElement("div");h.className="h";const b=document.createElement("b");b.textContent=m.from.name;h.append(b);
const k=document.createElement("span");k.textContent=m.from.kind+(m.to?" → "+m.to:"");h.append(k);
if(m.type!=="chat"){const g=document.createElement("span");g.className="tag "+m.type;g.textContent=m.type;h.append(g)}
const tm=document.createElement("span");tm.textContent=new Date(m.ts).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})+" · #"+m.seq;h.append(tm);
const t=document.createElement("div");t.className="t";t.textContent=m.text;d.append(h,t);
const near=log.scrollHeight-log.scrollTop-log.clientHeight<80;log.append(d);if(near||(me&&m.from.id===me.id))log.scrollTop=log.scrollHeight}
// An invite, not approved yet: show this tab's pairing code and nothing else. The socket stays open and hears "approved" or "denied".
function expired(){clearTimeout(pendTimer);setSec(null);log.innerHTML='<div class="gate"><p>The pairing code expired before the owner approved.</p><button id="again">Get a new code</button></div>';$("#again").onclick=()=>{log.innerHTML="";ws&&ws.readyState===1?start():connect()}}
function pending(f){clearTimeout(pendTimer);if(f.secret)setSec(f.secret);state.textContent="waiting for approval";state.className="";$("#f").hidden=true;
log.innerHTML='<div class="gate"><p>The owner of this room has to approve this device before you can read or post. Your pairing code:</p><p class="code" id="pc"></p><p>The owner sees the same code next to your request. Tell them the code; they approve only if it matches. It is valid for '+(f.expires_in_s>=90?Math.round(f.expires_in_s/60)+" minutes":f.expires_in_s+" seconds")+'.</p></div>';
$("#pc").textContent=f.code;pendTimer=setTimeout(expired,f.expires_in_s*1000)}
// Owners: join requests with Approve / Deny. Expired ones drop off without a round trip.
function showReqs(list){if(list)reqs=list.map(q=>({...q,until:Date.now()+q.expires_in_s*1000}));reqs=reqs.filter(q=>q.until>Date.now());
const box=$("#reqs");box.textContent="";box.hidden=!reqs.length;
for(const q of reqs){const row=document.createElement("div");row.className="rq";const d=document.createElement("div"),b=document.createElement("b"),c=document.createElement("b");
b.textContent=q.member.name;c.textContent=q.code;d.append(b," ("+q.member.kind+", "+q.member.role+") wants to join. Pairing code ",c,". Approve only if they see the same code."+(q.for_same_invite>1?" One of "+q.for_same_invite+" requests for this invitee: at most one is the person you invited.":""));
const y=document.createElement("button");y.textContent="Approve";y.onclick=()=>act("approve",q.code);
const n=document.createElement("button");n.className="no";n.textContent="Deny";n.onclick=()=>act("deny",q.code);row.append(d,y,n);box.append(row)}}
function act(t,code){if(ws&&ws.readyState===1)ws.send(JSON.stringify({t,code}))}
setInterval(()=>{if(reqs.some(q=>q.until<=Date.now()))showReqs()},5000);
function auth(){ws.send(JSON.stringify({t:"auth",token:tok,since:last>=0?last:undefined}))}
// A tab that already knocked comes back for its own request; otherwise sign in (an invite knocks, a member token gets the room).
function start(){sec?ws.send(JSON.stringify({t:"claim",secret:sec})):auth()}
function connect(){if(!tok)return gate();state.textContent="connecting…";state.className="";
ws=new WebSocket((location.protocol==="https:"?"wss://":"ws://")+location.host+"/r/"+ROOM+"/ws");
ws.onopen=start;
ws.onmessage=e=>{const f=JSON.parse(e.data);
 if(f.t==="hello"){clearTimeout(pendTimer);me=f.member;retry=0;$("#title").textContent=f.room.name||ROOM;state.textContent=me.name+" · live";state.className="live";$("#f").hidden=me.role==="read-only";f.messages.forEach(add);showReqs(f.requests||[])}
 else if(f.t==="msg")add(f.m);
 else if(f.t==="pending"){retry=0;pending(f)}
 else if(f.t==="approved")start();
 else if(f.t==="token"){clearTimeout(pendTimer);setSec(null);tok=f.token;try{localStorage.setItem(KEY,tok)}catch(e){};log.innerHTML="";auth()}
 else if(f.t==="error"&&f.code==="expired")expired();
 else if(f.t==="requests")showReqs(f.requests);
 else if(f.t==="error"){if(f.code==="unauthorized"||f.code==="revoked"){clearTimeout(pendTimer);setSec(null);try{localStorage.removeItem(KEY)}catch(e){};tok=null;gate('<span class="err">'+(f.denied?"The room owner denied this request. Ask them for a new invite.":"That token doesn\\'t work here (wrong room or revoked).")+'</span>')}else{state.textContent=f.message}}};
ws.onclose=e=>{state.textContent="offline · retrying";state.className="";if(e.code===4001||!tok)return;setTimeout(connect,Math.min(5000,300*2**retry++))}}
setInterval(()=>{if(ws&&ws.readyState===1)ws.send('{"t":"ping"}')},25000);
$("#f").onsubmit=e=>{e.preventDefault();const x=$("#text"),v=x.value.trim();if(!v||!ws||ws.readyState!==1)return;ws.send(JSON.stringify({t:"send",text:v,type:$("#type").value,client_id:crypto.randomUUID()}));x.value="";$("#type").value="chat"};
$("#text").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();$("#f").requestSubmit()}});
connect();
</script></body></html>`;
}

/** Shown after an unapproved invite is pasted on the sign-in page: this browser's pairing code, then
 *  a wait on its own request until the owner decides. The request's client secret stays in this one
 *  no-store page (a hidden field), so the approval can only finish the sign-in in the browser that
 *  showed the code. Nothing here goes in a URL. */
export function pairingPage(target: { host: string; known: boolean }, p: { token: string; secret: string; room: string; name?: string; code: string; expires_in_s: number }, nonce: string) {
  const valid = p.expires_in_s >= 90 ? `${Math.round(p.expires_in_s / 60)} minutes` : `${p.expires_in_s} seconds`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Waiting for approval · Phone Line</title>
<style nonce="${nonce}">${BASE_CSS}
main{max-width:440px;margin:12vh auto;padding:0 16px}h1{font-size:24px;margin:0 0 8px}p{color:var(--mute);margin:0 0 16px}
.code{font-size:40px;font-weight:650;font-variant-numeric:tabular-nums;color:var(--ink);margin:0 0 16px}
button{width:100%;border:0;border-radius:10px;background:var(--accent);color:#fff;padding:12px;font-weight:600}.err{color:var(--warn)}#s{color:var(--ink)}
</style></head><body><main>
<h1>Waiting for the room owner</h1>
<p>${p.name ? `You are connecting as <b>${esc(p.name)}</b>. ` : ""}The owner of the room has to approve this connection first. Your pairing code:</p>
<div id="c"><p class="code">${esc(p.code)}</p>
<p>The owner sees the same code next to your request. Tell them the code; they approve only if it matches. It is valid for ${valid}.</p></div>
<p>After approval, access goes to <b>${esc(target.host)}</b>.</p>
${!target.known ? `<p class="err">${esc(target.host)} is not a known Claude address. Only continue if you started this from an app you trust; otherwise close this page.</p>` : ""}
<p id="s" aria-live="polite">Waiting for approval. Keep this page open.</p>
<form method="post" id="f" data-room="${esc(p.room)}"><input type="hidden" name="token" value="${esc(p.token)}"><input type="hidden" name="secret" value="${esc(p.secret)}"><button id="b">Check now</button></form>
</main>
<script nonce="${nonce}">
const f=document.getElementById("f"),s=document.getElementById("s"),b=document.getElementById("b");
const stop=(msg,label)=>{document.getElementById("c").hidden=true;s.textContent=msg;s.className="err";if(label){b.textContent=label;f.secret.value=""}else f.hidden=true};
async function poll(){let again=3000;
 try{const r=await fetch("/r/"+f.dataset.room+"/knock?peek&timeout=25",{headers:{authorization:"Bearer "+f.secret.value}});
  if(r.status===200){s.textContent="Approved. Finishing sign-in.";f.submit();return}
  if(r.status===401||r.status===404)return stop("The room owner denied this request. Ask them for a new invite.");
  if(r.status===410)return stop("The pairing code expired before the owner approved.","Get a new code");
  if(r.status===202)again=0}catch(e){}
 setTimeout(poll,again)}
poll();
</script></body></html>`;
}

export function authorizePage(target: { host: string; known: boolean } | null, error: string | null, nonce: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Connect · Phone Line</title>
<style nonce="${nonce}">${BASE_CSS}
main{max-width:440px;margin:12vh auto;padding:0 16px}h1{font-size:24px;margin:0 0 8px}p{color:var(--mute);margin:0 0 16px}
input{width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--card);margin-bottom:12px}
button{width:100%;border:0;border-radius:10px;background:var(--accent);color:#fff;padding:12px;font-weight:600}.err{color:var(--warn)}
</style></head><body><main>
<h1>Connect an app to Phone Line</h1>
<p>Paste the invite token you were given. It decides which room this connection can read and post in.</p>
${target ? `<p>After you connect, access goes to <b>${esc(target.host)}</b>.</p>` : ""}
${target && !target.known ? `<p class="err">${esc(target.host)} is not a known Claude address. Only continue if you started this from an app you trust; otherwise close this page.</p>` : ""}
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post"><input name="token" placeholder="pl_…" autocomplete="off" required autofocus><button>Connect</button></form>
</main></body></html>`;
}
