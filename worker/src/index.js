// Stride Log server on Cloudflare Workers: accounts, sync, screenshot reading, nightly Health import, push reminders.
// Secrets (set by the GitHub deploy workflow): APP_PASSWORD (the owner's original password), ANTHROPIC_API_KEY.
import Anthropic from "@anthropic-ai/sdk";
import { generateVapid, sendPush, b64u, unb64u } from "./webpush.js";

const MODEL = "claude-sonnet-5-5";
const SUBJECT = "mailto:stride-log@users.noreply.github.com";
const OWNER = "owner"; // the account that holds the original single-user data
const READS_PER_DAY = 20; // screenshot reads per member per day (the owner is not capped)
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
const rid = (n = 12) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const num = (v) => { const x = parseFloat(String(v ?? "").replace(/,/g, "")); return isFinite(x) ? Math.round(x * 100) / 100 : null; };

// ---------- one-time move of the single-user data into the owner's account ----------
let migrated = false;
async function migrate(env) {
  if (migrated) return;
  if (!(await kvGet(env, "mig2"))) {
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO users (id, email, name, pw, role, created_at) VALUES (?, NULL, NULL, NULL, 'owner', ?)").bind(OWNER, Date.now()),
      env.DB.prepare("INSERT OR IGNORE INTO udocs (uid, coll, id, data, updated_at) SELECT ?, coll, id, data, updated_at FROM docs").bind(OWNER),
      env.DB.prepare("INSERT OR IGNORE INTO usubs (endpoint, uid, sub, created_at) SELECT endpoint, ?, sub, created_at FROM subs").bind(OWNER),
    ]);
    await kvSet(env, "mig2", Date.now());
  }
  migrated = true;
}

// ---------- passwords (PBKDF2) ----------
async function hashPw(pw, saltB64) {
  const salt = saltB64 ? unb64u(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return "pbkdf2$100000$" + b64u(salt) + "$" + b64u(bits);
}
async function checkPw(pw, stored) {
  if (!stored || typeof pw !== "string") return false;
  const [, , salt, h] = stored.split("$");
  const again = await hashPw(pw, salt);
  return same(again.split("$")[3], h);
}

// ---------- sessions: long-lived signed token that names the account ----------
async function makeToken(env, uid) {
  const payload = b64u(enc.encode(JSON.stringify({ uid, exp: Date.now() + 365 * 864e5 })));
  return payload + "." + (await hmac(env, "session:" + payload));
}
async function tokenUser(env, t) {
  if (!t || !t.includes(".")) return null;
  const [payload, sig] = t.split(".");
  if (!same(sig, await hmac(env, "session:" + payload))) return null;
  let p; try { p = JSON.parse(new TextDecoder().decode(unb64u(payload))); } catch { return null; }
  if (!(p.exp > Date.now())) return null;
  const uid = p.uid || OWNER; // tokens from before accounts existed belong to the owner
  const u = await env.DB.prepare("SELECT id, email, name, role, seen_at FROM users WHERE id = ?").bind(uid).first();
  if (u && (!u.seen_at || u.seen_at < Date.now() - 36e5)) await env.DB.prepare("UPDATE users SET seen_at = ? WHERE id = ?").bind(Date.now(), uid).run();
  return u || null;
}
const bearer = (req, url) => (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("t") || "";
const pub = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });
const cleanEmail = (e) => String(e || "").trim().toLowerCase();
const okEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 120;

// ---------- accounts ----------
async function login(req, env) {
  const { email, password } = await req.json().catch(() => ({}));
  await new Promise((r) => setTimeout(r, 400)); // slow down guessing
  if (typeof password !== "string" || !password) return json({ error: "wrong_password" }, 401);
  const e = cleanEmail(email);
  if (e) {
    const u = await env.DB.prepare("SELECT id, email, name, role, pw FROM users WHERE email = ?").bind(e).first();
    if (!u || !(await checkPw(password, u.pw))) return json({ error: "wrong_password" }, 401);
    return json({ token: await makeToken(env, u.id), user: pub(u) });
  }
  // the original app password still opens the owner's account
  if (env.APP_PASSWORD && same(password, env.APP_PASSWORD)) {
    const u = await env.DB.prepare("SELECT id, email, name, role FROM users WHERE id = ?").bind(OWNER).first();
    return json({ token: await makeToken(env, OWNER), user: pub(u) });
  }
  return json({ error: "wrong_password" }, 401);
}
async function inviteCode(env) {
  let c = await kvGet(env, "invite");
  if (!c) { c = rid(6).replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toUpperCase().padEnd(6, "X"); await kvSet(env, "invite", c); }
  return c;
}
async function signup(req, env) {
  const { name, email, password, invite } = await req.json().catch(() => ({}));
  await new Promise((r) => setTimeout(r, 400));
  const open = !!(await kvGet(env, "open_signup"));
  if (!open && String(invite || "").trim().toUpperCase() !== (await inviteCode(env))) return json({ error: "bad_invite" }, 403);
  const e = cleanEmail(email);
  if (!okEmail(e)) return json({ error: "bad_email" }, 400);
  if (typeof password !== "string" || password.length < 8 || password.length > 200) return json({ error: "short_password" }, 400);
  const n = String(name || "").trim().slice(0, 60);
  if (!n) return json({ error: "no_name" }, 400);
  if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(e).first()) return json({ error: "email_taken" }, 409);
  const id = "u_" + rid(9);
  await env.DB.prepare("INSERT INTO users (id, email, name, pw, role, created_at, seen_at) VALUES (?, ?, ?, ?, 'member', ?, ?)")
    .bind(id, e, n, await hashPw(password), Date.now(), Date.now()).run();
  return json({ token: await makeToken(env, id), user: { id, email: e, name: n, role: "member" } });
}
async function updateMe(req, env, u) {
  const { name, email, password } = await req.json().catch(() => ({}));
  const sets = [], vals = [];
  if (name !== undefined) { const n = String(name).trim().slice(0, 60); if (!n) return json({ error: "no_name" }, 400); sets.push("name = ?"); vals.push(n); }
  if (email !== undefined) {
    const e = cleanEmail(email); if (!okEmail(e)) return json({ error: "bad_email" }, 400);
    const other = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(e).first();
    if (other && other.id !== u.id) return json({ error: "email_taken" }, 409);
    sets.push("email = ?"); vals.push(e);
  }
  if (password !== undefined) {
    if (typeof password !== "string" || password.length < 8) return json({ error: "short_password" }, 400);
    sets.push("pw = ?"); vals.push(await hashPw(password));
  }
  if (sets.length) await env.DB.prepare("UPDATE users SET " + sets.join(", ") + " WHERE id = ?").bind(...vals, u.id).run();
  const fresh = await env.DB.prepare("SELECT id, email, name, role FROM users WHERE id = ?").bind(u.id).first();
  return json({ user: pub(fresh) });
}
async function deleteUser(env, uid) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM udocs WHERE uid = ?").bind(uid),
    env.DB.prepare("DELETE FROM usubs WHERE uid = ?").bind(uid),
    env.DB.prepare("DELETE FROM ushots WHERE uid = ?").bind(uid),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(uid),
  ]);
}
async function admin(req, env, url, p) {
  if (p === "/admin" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT u.id, u.email, u.name, u.role, u.created_at, u.seen_at, (SELECT COUNT(*) FROM udocs d WHERE d.uid = u.id AND d.coll = 'logs') AS logs FROM users u ORDER BY u.created_at").all();
    return json({ invite: await inviteCode(env), open: !!(await kvGet(env, "open_signup")), users: results });
  }
  if (p === "/admin/invite" && req.method === "POST") { await kvSet(env, "invite", null); await env.DB.prepare("DELETE FROM kv WHERE k = 'invite'").run(); return json({ invite: await inviteCode(env) }); }
  if (p === "/admin/open" && req.method === "POST") { const { open } = await req.json().catch(() => ({})); await kvSet(env, "open_signup", !!open); return json({ open: !!open }); }
  let m = p.match(/^\/admin\/users\/([A-Za-z0-9_\-]+)$/);
  if (m && req.method === "DELETE") { if (m[1] === OWNER) return json({ error: "cannot_remove_owner" }, 400); await deleteUser(env, m[1]); return json({ ok: true }); }
  m = p.match(/^\/admin\/users\/([A-Za-z0-9_\-]+)\/reset$/);
  if (m && req.method === "POST") {
    const temp = rid(6).replace(/[^A-Za-z0-9]/g, "").slice(0, 8).padEnd(8, "7");
    const r = await env.DB.prepare("UPDATE users SET pw = ? WHERE id = ? AND id != ?").bind(await hashPw(temp), m[1], OWNER).run();
    if (!r.meta || !r.meta.changes) return json({ error: "not_found" }, 404);
    return json({ password: temp });
  }
  return json({ error: "not_found" }, 404);
}

// ---------- each account's documents ----------
async function listDocs(env, uid, url) {
  const colls = (url.searchParams.get("coll") || "logs,daily,settings").split(",").slice(0, 10);
  const q = "SELECT coll, id, data FROM udocs WHERE uid = ? AND coll IN (" + colls.map(() => "?").join(",") + ")";
  const { results } = await env.DB.prepare(q).bind(uid, ...colls).all();
  return json({ docs: results.map((r) => ({ coll: r.coll, id: r.id, data: JSON.parse(r.data) })) });
}
async function putDoc(env, uid, coll, id, data) {
  await env.DB.prepare("INSERT INTO udocs (uid, coll, id, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(uid, coll, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
    .bind(uid, coll, id, JSON.stringify(data), Date.now()).run();
}
async function getDoc(env, uid, coll, id) {
  const r = await env.DB.prepare("SELECT data FROM udocs WHERE uid = ? AND coll = ? AND id = ?").bind(uid, coll, id).first();
  return r ? JSON.parse(r.data) : null;
}

async function readShots(req, env, u) {
  const { prompt, images } = await req.json().catch(() => ({}));
  if (!Array.isArray(images) || !images.length || images.length > 4) return json({ error: "bad_images" }, 400);
  if (!env.ANTHROPIC_API_KEY) return json({ error: "no_api_key" }, 500);
  if (u.role !== "owner") {
    const k = "reads:" + u.id + ":" + new Date().toISOString().slice(0, 10);
    const n = (await kvGet(env, k)) || 0;
    if (n >= READS_PER_DAY) return json({ error: "daily_limit" }, 429);
    await kvSet(env, k, n + 1);
  }
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

async function putShot(req, env, uid) {
  const type = (req.headers.get("content-type") || "").split(";")[0];
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return json({ error: "bad_type" }, 400);
  const buf = await req.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > 1.8e6) return json({ error: "too_large" }, 413);
  const id = Date.now().toString(36) + rid(6);
  await env.DB.prepare("INSERT INTO ushots (id, uid, type, data, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, uid, type, buf, Date.now()).run();
  return json({ id });
}
async function getShot(env, uid, id) {
  let r = await env.DB.prepare("SELECT type, data FROM ushots WHERE id = ? AND uid = ?").bind(id, uid).first();
  if (!r && uid === OWNER) r = await env.DB.prepare("SELECT type, data FROM shots WHERE id = ?").bind(id).first();
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
// The owner's link (no u=) is the original one, so the existing Shortcut keeps working.
async function ingestToken(env, uid) { return (await hmac(env, uid === OWNER ? "ingest" : "ingest:" + uid)).slice(0, 32); }
async function ingest(req, env, url) {
  const uid = url.searchParams.get("u") || OWNER;
  if (!same(url.searchParams.get("t") || "", await ingestToken(env, uid))) return json({ error: "bad_token" }, 403);
  if (!(await env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(uid).first())) return json({ error: "bad_token" }, 403);
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
  await putDoc(env, uid, "daily", date, data);
  return json({ ok: true, date, data });
}

async function subscribe(req, env, uid) {
  const { sub } = await req.json().catch(() => ({}));
  if (!sub || !sub.endpoint || !sub.keys) return json({ error: "bad_sub" }, 400);
  await env.DB.prepare("INSERT INTO usubs (endpoint, uid, sub, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET sub = excluded.sub, uid = excluded.uid").bind(sub.endpoint, uid, JSON.stringify(sub), Date.now()).run();
  return json({ ok: true });
}
async function pushTo(env, uid, items) {
  const v = await vapid(env);
  const { results } = await env.DB.prepare("SELECT endpoint, sub FROM usubs WHERE uid = ?").bind(uid).all();
  let pushed = 0;
  for (const it of items) for (const s of results) {
    try {
      const st = await sendPush(JSON.parse(s.sub), JSON.stringify({ title: it.title, body: it.body, tag: it.id }), v, SUBJECT);
      if (st === 404 || st === 410) await env.DB.prepare("DELETE FROM usubs WHERE endpoint = ?").bind(s.endpoint).run();
      else if (st < 300) pushed++;
    } catch (e) { /* keep going */ }
  }
  return { pushed, phones: results.length };
}
async function dueReminders(env) {
  await migrate(env);
  const { results } = await env.DB.prepare("SELECT uid, data FROM udocs WHERE coll = 'reminders' AND id = 'upcoming'").all();
  const now = Date.now();
  for (const row of results) {
    const doc = JSON.parse(row.data); const sent = doc.sent || [];
    const due = (doc.items || []).filter((it) => it.at <= now && it.at > now - 20 * 60e3 && !sent.includes(it.id));
    if (!due.length) continue;
    await pushTo(env, row.uid, due);
    const fresh = (await getDoc(env, row.uid, "reminders", "upcoming")) || doc;
    fresh.sent = [...new Set([...(fresh.sent || []), ...due.map((i) => i.id)])].slice(-100);
    await putDoc(env, row.uid, "reminders", "upcoming", fresh);
  }
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    try {
      await migrate(env);
      // open routes
      if (p === "/") return json({ ok: true, service: "stride-log" });
      if (p === "/login" && req.method === "POST") return await login(req, env);
      if (p === "/signup" && req.method === "POST") return await signup(req, env);
      if (p === "/signup-info") return json({ open: !!(await kvGet(env, "open_signup")) });
      if (p === "/ingest" && req.method === "POST") return await ingest(req, env, url);
      if (p === "/vapid") return json({ publicKey: (await vapid(env)).publicKey });
      // everything else needs a signed-in account
      const u = await tokenUser(env, bearer(req, url));
      if (!u) return json({ error: "signed_out" }, 401);
      if (p === "/me" && req.method === "GET") return json({ user: pub(u) });
      if (p === "/me" && req.method === "PUT") return await updateMe(req, env, u);
      if (p === "/me" && req.method === "DELETE") { if (u.role === "owner") return json({ error: "cannot_remove_owner" }, 400); await deleteUser(env, u.id); return json({ ok: true }); }
      if (p.startsWith("/admin")) { if (u.role !== "owner") return json({ error: "forbidden" }, 403); return await admin(req, env, url, p); }
      if (p === "/docs" && req.method === "GET") return await listDocs(env, u.id, url);
      let m = p.match(/^\/docs\/([a-z_]+)\/([A-Za-z0-9_\-@.]+)$/);
      if (m && req.method === "PUT") { await putDoc(env, u.id, m[1], m[2], await req.json()); return json({ ok: true }); }
      if (m && req.method === "DELETE") { await env.DB.prepare("DELETE FROM udocs WHERE uid = ? AND coll = ? AND id = ?").bind(u.id, m[1], m[2]).run(); return json({ ok: true }); }
      if (p === "/read" && req.method === "POST") return await readShots(req, env, u);
      if (p === "/shots" && req.method === "POST") return await putShot(req, env, u.id);
      m = p.match(/^\/shots\/([A-Za-z0-9_\-]+)$/);
      if (m && req.method === "GET") return await getShot(env, u.id, m[1]);
      if (p === "/subscribe" && req.method === "POST") return await subscribe(req, env, u.id);
      if (p === "/ingest-link") return json({ url: url.origin + "/ingest?" + (u.id === OWNER ? "" : "u=" + encodeURIComponent(u.id) + "&") + "t=" + (await ingestToken(env, u.id)) });
      if (p === "/push-test" && req.method === "POST") return json(await pushTo(env, u.id, [{ id: "test-" + Date.now(), title: "Stride Log", body: "Reminders are working." }]));
      return json({ error: "not_found" }, 404);
    } catch (e) {
      return json({ error: "server", detail: String((e && e.message) || e).slice(0, 300) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dueReminders(env));
  },
};
