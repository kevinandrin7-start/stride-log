// Stride Log server function. Deploy as one Edge Function named "api"
// with "Enforce JWT verification" turned OFF (it checks sign-ins itself).
// Secret needed: ANTHROPIC_API_KEY (Edge Functions -> Secrets).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import Anthropic from "npm:@anthropic-ai/sdk";
import webpush from "npm:web-push@3.6.7";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const MODEL = "claude-sonnet-5-5";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function userFrom(req: Request) {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!t) return null;
  const { data } = await admin.auth.getUser(t);
  return data?.user ?? null;
}

async function vapid() {
  const { data } = await admin.from("server_kv").select("v").eq("k", "vapid").maybeSingle();
  if (data?.v?.publicKey) return data.v as { publicKey: string; privateKey: string };
  const keys = webpush.generateVAPIDKeys();
  await admin.from("server_kv").upsert({ k: "vapid", v: keys });
  return keys;
}

const num = (v: unknown) => {
  const x = parseFloat(String(v ?? "").replace(/,/g, ""));
  return isFinite(x) ? Math.round(x * 100) / 100 : null;
};

// ---------- screenshot reading ----------
async function readShots(req: Request) {
  const user = await userFrom(req);
  if (!user) return json({ error: "signed_out" }, 401);
  const { prompt, images } = await req.json();
  if (!Array.isArray(images) || !images.length || images.length > 4) return json({ error: "bad_images" }, 400);
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "no_api_key" }, 500);
  const client = new Anthropic({ apiKey: key });
  const content: any[] = images.map((im: { type: string; data: string }) => ({
    type: "image",
    source: { type: "base64", media_type: im.type, data: im.data },
  }));
  content.push({ type: "text", text: String(prompt).slice(0, 6000) });
  try {
    const msg: any = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" },
      messages: [{ role: "user", content }],
    } as any);
    const text = (msg.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return json({ error: "no_json" }, 502);
    return json({ result: JSON.parse(m[0]), usage: msg.usage });
  } catch (e: any) {
    return json({ error: e?.status === 429 ? "rate_limited" : "api_error", detail: String(e?.message || e).slice(0, 300) }, 502);
  }
}

// ---------- nightly Health stats from the iPhone Shortcut ----------
async function ingest(req: Request, url: URL) {
  const token = url.searchParams.get("t") || "";
  const { data: row } = await admin.from("ingest_tokens").select("user_id").eq("token", token).maybeSingle();
  if (!row) return json({ error: "bad_token" }, 403);
  let body: Record<string, unknown> = {};
  const raw = await req.text();
  try { body = JSON.parse(raw); } catch {
    // Also accept the "STRIDELOG v1" email-style text, one "key: value" per line.
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([a-z_]+)\s*[:=]\s*(.+?)\s*$/i);
      if (m) body[m[1].toLowerCase()] = m[2];
    }
  }
  const date = String(body.date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "bad_date" }, 400);
  const data: Record<string, unknown> = { source: "shortcut", importedAt: Date.now() };
  for (const k of ["steps", "active_cal", "distance_mi", "hr_avg", "hr_min", "hr_max", "resting_hr"]) {
    const v = num(body[k]);
    data[k] = v == null ? null : k === "distance_mi" ? v : Math.round(v);
  }
  const { error } = await admin.from("docs").upsert({ user_id: row.user_id, coll: "daily", id: date, data, updated_at: new Date().toISOString() });
  if (error) return json({ error: "db", detail: error.message }, 500);
  return json({ ok: true, date });
}

// ---------- push reminders ----------
async function subscribe(req: Request) {
  const user = await userFrom(req);
  if (!user) return json({ error: "signed_out" }, 401);
  const { sub } = await req.json();
  if (!sub?.endpoint) return json({ error: "bad_sub" }, 400);
  await admin.from("push_subs").upsert({ endpoint: sub.endpoint, user_id: user.id, sub });
  return json({ ok: true });
}

async function reminders(test: string | null, req: Request) {
  const keys = await vapid();
  webpush.setVapidDetails("mailto:stride-log@example.com", keys.publicKey, keys.privateKey);
  const now = Date.now();
  let targets: { user_id: string; items: any[]; sent: string[] }[] = [];
  if (test) {
    const user = await userFrom(req);
    if (!user) return json({ error: "signed_out" }, 401);
    targets = [{ user_id: user.id, items: [{ id: "test-" + now, title: "Stride Log", body: "Reminders are working." }], sent: [] }];
  } else {
    const { data } = await admin.from("docs").select("user_id,data").eq("coll", "reminders").eq("id", "upcoming");
    for (const r of data || []) {
      const sent: string[] = r.data?.sent || [];
      const due = (r.data?.items || []).filter((it: any) => it.at <= now && it.at > now - 20 * 60e3 && !sent.includes(it.id));
      if (due.length) targets.push({ user_id: r.user_id, items: due, sent });
    }
  }
  let pushed = 0;
  for (const t of targets) {
    const { data: subs } = await admin.from("push_subs").select("endpoint,sub").eq("user_id", t.user_id);
    for (const it of t.items) {
      for (const s of subs || []) {
        try { await webpush.sendNotification(s.sub, JSON.stringify({ title: it.title, body: it.body, tag: it.id })); pushed++; }
        catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) await admin.from("push_subs").delete().eq("endpoint", s.endpoint); }
      }
    }
    if (!test) {
      const { data: doc } = await admin.from("docs").select("data").eq("user_id", t.user_id).eq("coll", "reminders").eq("id", "upcoming").maybeSingle();
      const d = doc?.data || {};
      d.sent = [...new Set([...(d.sent || []), ...t.items.map((i) => i.id)])].slice(-100);
      await admin.from("docs").update({ data: d }).eq("user_id", t.user_id).eq("coll", "reminders").eq("id", "upcoming");
    }
  }
  return json({ ok: true, pushed });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/api/, "") || "/";
  try {
    if (route === "/read" && req.method === "POST") return await readShots(req);
    if (route === "/ingest" && req.method === "POST") return await ingest(req, url);
    if (route === "/vapid") return json({ publicKey: (await vapid()).publicKey });
    if (route === "/subscribe" && req.method === "POST") return await subscribe(req);
    if (route === "/reminders") return await reminders(url.searchParams.get("test"), req);
    return json({ ok: true, service: "stride-log" });
  } catch (e: any) {
    return json({ error: "server", detail: String(e?.message || e).slice(0, 300) }, 500);
  }
});
