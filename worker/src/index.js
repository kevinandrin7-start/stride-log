// Stride Log server on Cloudflare Workers: sync, screenshot reading, nightly Health import, push reminders.
// Secrets (set by the GitHub deploy workflow): APP_PASSWORD, ANTHROPIC_API_KEY.
import Anthropic from "@anthropic-ai/sdk";
import { generateVapid, sendPush, b64u, unb64u } from "./webpush.js";

const MODEL = "claude-sonnet-5-5";
const SUBJECT = "mailto:stride-log@users.noreply.github.com";
const enc = new TextEncoder();
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---------- small key/value store in D1 ----------
async function kvGet(env, k) {
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind(k).first();
  return r ? JSON.parse(r.v) : null;
}
async function kvSet(env, k, v) {
  await env.DB.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, JSON.stringify(v)).run();
}
async function serverSecret(env) {
  let s = await kvGet(env, "secret");
  if (!s) { s = b64u(crypto.getRandomValues(new Uint8Array(32))); await kvSet(env, "secret", s); }
  return s;
}
async function vapid(env) {
  let v = await kvGet(env, "vapid");
  if (!v) { v = await generateVapid(); await kvSet(env, "vapid", v); }
  return v;
}
async function hmac(env, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(await serverSecret(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

// ---------- sign-in: one password, long-lived signed token ----------
async function makeToken(env) {
  const payload = b64u(enc.encode(JSON.stringify({ exp: Date.now() + 365 * 864e5 })));
  return payload + "." + (await hmac(env, "session:" + payload));
}
async function checkToken(env, t) {
  if (!t || !t.includes(".")) return false;
  const [payload, sig] = t.split(".");
  if (!same(sig, await hmac(env, "session:" + payload))) return false;
  try { return JSON.parse(new TextDecoder().decode(unb64u(payload))).exp > Date.now(); } catch { return false; }
}
const bearer = (req, url) => (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("t") || "";

const num = (v) => { const x = parseFloat(String(v ?? "").replace(/,/g, "")); return isFinite(x) ? Math.round(x * 100) / 100 : null; };

// ---------- routes ----------
async function login(req, env) {
  if (!env.APP_PASSWORD) return json({ error: "no_password_set" }, 500);
  const { password } = await req.json().catch(() => ({}));
  await new Promise((r) => setTimeout(r, 400)); // slow down guessing
  if (typeof password !== "string" || !same(password, env.APP_PASSWORD)) return json({ error: "wrong_password" }, 401);
  return json({ token: await makeToken(env) });
}

async function listDocs(env, url) {
  const colls = (url.searchParams.get("coll") || "logs,daily,settings").split(",");
  const q = "SELECT coll, id, data FROM docs WHERE coll IN (" + colls.map(() => "?").join(",") + ")";
  const { results } = await env.DB.prepare(q).bind(...colls).all();
  return json({ docs: results.map((r) => ({ coll: r.coll, id: r.id, data: JSON.parse(r.data) })) });
}
async function putDoc(env, coll, id, data) {
  await env.DB.prepare("INSERT INTO docs (coll, id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(coll, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
    .bind(coll, id, JSON.stringify(data), Date.now()).run();
}
async function getDoc(env, coll, id) {
  const r = await env.DB.prepare("SELECT data FROM docs WHERE coll = ? AND id = ?").bind(coll, id).first();
  return r ? JSON.parse(r.data) : null;
}

async function readShots(req, env) {
  const { prompt, images } = await req.json().catch(() => ({}));
  if (!Array.isArray(images) || !images.length || images.length > 4) return json({ error: "bad_images" }, 400);
  if (!env.ANTHROPIC_API_KEY) return json({ error: "no_api_key" }, 500);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const content = images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.type, data: im.data } }));
  content.push({ type: "text", text: String(prompt || "").slice(0, 6000) });
  try {
    const msg = await client.messages.create({ model: MODEL, max_tokens: 4000, output_config: { effort: "low" }, messages: [{ role: "user", content }] });
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return json({ error: "no_json" }, 502);
    return json({ result: JSON.parse(m[0]), usage: msg.usage });
  } catch (e) {
    return json({ error: e && e.status === 429 ? "rate_limited" : "api_error", detail: String((e && e.message) || e).slice(0, 300) }, 502);
  }
}

async function putShot(req, env) {
  const type = (req.headers.get("content-type") || "").split(";")[0];
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return json({ error: "bad_type" }, 400);
  const buf = await req.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > 1.8e6) return json({ error: "too_large" }, 413);
  const id = Date.now().toString(36) + b64u(crypto.getRandomValues(new Uint8Array(6)));
  await env.DB.prepare("INSERT INTO shots (id, type, data, created_at) VALUES (?, ?, ?, ?)").bind(id, type, buf, Date.now()).run();
  return json({ id });
}
async function getShot(env, id) {
  const r = await env.DB.prepare("SELECT type, data FROM shots WHERE id = ?").bind(id).first();
  if (!r) return new Response("not found", { status: 404, headers: CORS });
  return new Response(new Uint8Array(r.data), { headers: { ...CORS, "Content-Type": r.type, "Cache-Control": "private, max-age=31536000, immutable" } });
}


// Accepts 2026-11-07, 11/7/2026, 11/7/26, "Nov 7, 2026", "November 7, 2026 at 11:00 PM"; blank means today in New York.
function parseDate(v) {
  const s = String(v || "").trim();
  if (!s) return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return y + "-" + m[1].padStart(2, "0") + "-" + m[2].padStart(2, "0"); }
  const d = new Date(s.replace(/\s+at\s+.*$/i, ""));
  if (!isNaN(d)) return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  return null;
}
async function ingestToken(env) { return (await hmac(env, "ingest")).slice(0, 32); }
async function ingest(req, env, url) {
  if (!same(url.searchParams.get("t") || "", await ingestToken(env))) return json({ error: "bad_token" }, 403);
  const raw = await req.text();
  let body = {};
  try { body = JSON.parse(raw); } catch {
    for (const line of raw.split(/\r?\n/)) { const m = line.match(/^\s*([a-z_]+)\s*[:=]\s*(.+?)\s*$/i); if (m) body[m[1].toLowerCase()] = m[2]; }
  }
  const date = parseDate(body.date);
  if (!date) return json({ error: "bad_date", got: String(body.date || "").slice(0, 40) }, 400);
  const data = { source: "shortcut", importedAt: Date.now() };
  for (const k of ["steps", "active_cal", "distance_mi", "hr_avg", "hr_min", "hr_max", "resting_hr"]) {
    const v = num(body[k]); data[k] = v == null ? null : k === "distance_mi" ? v : Math.round(v);
  }
  await putDoc(env, "daily", date, data);
  return json({ ok: true, date, data });
}

async function subscribe(req, env) {
  const { sub } = await req.json().catch(() => ({}));
  if (!sub || !sub.endpoint || !sub.keys) return json({ error: "bad_sub" }, 400);
  await env.DB.prepare("INSERT INTO subs (endpoint, sub, created_at) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET sub = excluded.sub").bind(sub.endpoint, JSON.stringify(sub), Date.now()).run();
  return json({ ok: true });
}
async function pushAll(env, items) {
  const v = await vapid(env);
  const { results } = await env.DB.prepare("SELECT endpoint, sub FROM subs").all();
  let pushed = 0;
  for (const it of items) for (const s of results) {
    try {
      const st = await sendPush(JSON.parse(s.sub), JSON.stringify({ title: it.title, body: it.body, tag: it.id }), v, SUBJECT);
      if (st === 404 || st === 410) await env.DB.prepare("DELETE FROM subs WHERE endpoint = ?").bind(s.endpoint).run();
      else if (st < 300) pushed++;
    } catch (e) { /* keep going */ }
  }
  return { pushed, phones: results.length };
}
async function dueReminders(env) {
  const doc = await getDoc(env, "reminders", "upcoming");
  if (!doc) return { pushed: 0 };
  const now = Date.now(); const sent = doc.sent || [];
  const due = (doc.items || []).filter((it) => it.at <= now && it.at > now - 20 * 60e3 && !sent.includes(it.id));
  if (!due.length) return { pushed: 0 };
  const r = await pushAll(env, due);
  const fresh = (await getDoc(env, "reminders", "upcoming")) || doc;
  fresh.sent = [...new Set([...(fresh.sent || []), ...due.map((i) => i.id)])].slice(-100);
  await putDoc(env, "reminders", "upcoming", fresh);
  return r;
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    try {
      // open routes
      if (p === "/") return json({ ok: true, service: "stride-log" });
      if (p === "/login" && req.method === "POST") return await login(req, env);
      if (p === "/ingest" && req.method === "POST") return await ingest(req, env, url);
      if (p === "/vapid") return json({ publicKey: (await vapid(env)).publicKey });
      // everything else needs the sign-in token
      if (!(await checkToken(env, bearer(req, url)))) return json({ error: "signed_out" }, 401);
      if (p === "/docs" && req.method === "GET") return await listDocs(env, url);
      let m = p.match(/^\/docs\/([a-z_]+)\/([A-Za-z0-9_\-@.]+)$/);
      if (m && req.method === "PUT") { await putDoc(env, m[1], m[2], await req.json()); return json({ ok: true }); }
      if (m && req.method === "DELETE") { await env.DB.prepare("DELETE FROM docs WHERE coll = ? AND id = ?").bind(m[1], m[2]).run(); return json({ ok: true }); }
      if (p === "/read" && req.method === "POST") return await readShots(req, env);
      if (p === "/shots" && req.method === "POST") return await putShot(req, env);
      m = p.match(/^\/shots\/([A-Za-z0-9_\-]+)$/);
      if (m && req.method === "GET") return await getShot(env, m[1]);
      if (p === "/subscribe" && req.method === "POST") return await subscribe(req, env);
      if (p === "/ingest-link") return json({ url: url.origin + "/ingest?t=" + (await ingestToken(env)) });
      if (p === "/push-test" && req.method === "POST") return json(await pushAll(env, [{ id: "test-" + Date.now(), title: "Stride Log", body: "Reminders are working." }]));
      return json({ error: "not_found" }, 404);
    } catch (e) {
      return json({ error: "server", detail: String((e && e.message) || e).slice(0, 300) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dueReminders(env));
  },
};
