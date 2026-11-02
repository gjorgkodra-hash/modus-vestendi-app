// Instagram + Meta Ads bridge for the Modus Vestendi inventory app.
// Token and IDs live in Supabase Vault (meta_token, ig_user_id). Callers: staff users (JWT + role) or the cron job (x-cron-key).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const G = "https://graph.facebook.com/v26.0";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const secret = async (n: string) => (await admin.rpc("_secret", { p_name: n })).data as string | null;

let TOKEN = "", IG = "";
class GErr extends Error { constructor(public body: any) { super(body?.error?.message ?? "graph error"); } }
async function g(path: string, params: Record<string, unknown> = {}, method = "GET") {
  const u = new URL(path.startsWith("http") ? path : G + path);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (method === "GET") u.searchParams.set(k, s); else body.set(k, s);
  }
  if (!u.searchParams.has("access_token")) u.searchParams.set("access_token", TOKEN);
  const r = await fetch(u, method === "GET" ? {} : { method, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new GErr(j);
  return j;
}
async function gAll(path: string, params: Record<string, unknown> = {}, max = 10) {
  let j = await g(path, params), out = [...(j.data ?? [])];
  for (let i = 0; i < max && j.paging?.next; i++) { j = await g(j.paging.next); out = out.concat(j.data ?? []); }
  return out;
}
const day = (d: Date) => d.toISOString().slice(0, 10);
const unix = (s: string) => Math.floor(new Date(s + "T00:00:00Z").getTime() / 1000);
const addDays = (s: string, n: number) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return day(d); };

// ---------- account ----------
const DAY_METRICS = ["reach", "views", "accounts_engaged", "total_interactions", "profile_views", "website_clicks"];
const COL: Record<string, string> = { reach: "reach", views: "views", accounts_engaged: "accounts_engaged", total_interactions: "interactions", profile_views: "profile_views", website_clicks: "website_clicks" };
async function dayInsights(d: string, metrics: string[]) {
  const out: Record<string, number> = {};
  try {
    const j = await g(`/${IG}/insights`, { metric: metrics.join(","), period: "day", metric_type: "total_value", since: unix(d), until: unix(addDays(d, 1)) });
    for (const m of j.data ?? []) out[m.name] = m.total_value?.value ?? 0;
  } catch (e) {
    if (metrics.length === 1) return out;
    for (const m of metrics) Object.assign(out, await dayInsights(d, [m])); // find the metrics that work
  }
  return out;
}
async function syncAccount(full: boolean) {
  const p = await g(`/${IG}`, { fields: "id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,website" });
  await admin.from("ig_state").upsert({ k: "profile", v: p, updated_at: new Date().toISOString() });
  const today = day(new Date());
  const { count } = await admin.from("ig_daily").select("day", { count: "exact", head: true });
  const back = full || (count ?? 0) < 7 ? 28 : 3;
  // new followers per day (only available for the last 30 days)
  const nf: Record<string, number> = {};
  try {
    const j = await g(`/${IG}/insights`, { metric: "follower_count", period: "day", since: unix(addDays(today, -29)), until: unix(today) });
    for (const v of j.data?.[0]?.values ?? []) nf[addDays(String(v.end_time).slice(0, 10), -1)] = v.value;
  } catch (_) { /* not available for small accounts */ }
  const rows: any[] = [];
  let metrics = DAY_METRICS;
  for (let i = back; i >= 1; i--) {
    const d = addDays(today, -i);
    const ins = await dayInsights(d, metrics);
    if (i === back) metrics = DAY_METRICS.filter((m) => m in ins); // skip unsupported metrics afterwards
    const r: any = { day: d, updated_at: new Date().toISOString() };
    for (const [k, v] of Object.entries(ins)) r[COL[k]] = v;
    if (d in nf) r.new_followers = nf[d];
    rows.push(r);
  }
  // follower totals: today exact, earlier days reconstructed from daily new followers (only where unknown)
  const { data: known } = await admin.from("ig_daily").select("day,followers").gte("day", addDays(today, -back));
  const has = new Map((known ?? []).map((k: any) => [k.day, k.followers]));
  let f = p.followers_count;
  rows.push({ day: today, followers: f, updated_at: new Date().toISOString() });
  for (let i = rows.length - 2; i >= 0; i--) {
    const next = rows[i + 1];
    f = f - (next.new_followers ?? nf[next.day] ?? 0);
    if (has.get(rows[i].day) == null) rows[i].followers = f;
  }
  for (const r of rows) await admin.from("ig_daily").upsert(r, { onConflict: "day" });
  return { followers: p.followers_count, days: rows.length };
}

// ---------- media ----------
const MEDIA_FIELDS = "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count";
async function mediaInsights(id: string, type: string) {
  const sets = type === "VIDEO" || type === "REELS"
    ? ["reach,views,saved,shares,total_interactions", "reach,saved,shares,total_interactions", "reach"]
    : ["reach,views,saved,shares,total_interactions", "reach,saved,total_interactions", "reach"];
  for (const s of sets) {
    try {
      const j = await g(`/${id}/insights`, { metric: s });
      const o: Record<string, number> = {};
      for (const m of j.data ?? []) o[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0;
      return o;
    } catch (_) { /* try a smaller set */ }
  }
  return {};
}
function mediaRow(m: any, ins: Record<string, number>) {
  const link = String(m.caption ?? "").match(/shop\.modusvestendi\.com\/p\/(\d+)/);
  const r: any = {
    id: m.id, caption: m.caption ?? null, media_type: m.media_type, product_type: m.media_product_type ?? null,
    media_url: m.media_url ?? null, thumbnail_url: m.thumbnail_url ?? null, permalink: m.permalink, ts: m.timestamp,
    like_count: m.like_count ?? 0, comments_count: m.comments_count ?? 0,
    reach: ins.reach ?? null, views: ins.views ?? null, saved: ins.saved ?? null, shares: ins.shares ?? null, interactions: ins.total_interactions ?? null,
    synced_at: new Date().toISOString(),
  };
  if (link) r.model_id = Number(link[1]);
  return r;
}
async function syncMedia(limit = 50) {
  const list = (await g(`/${IG}/media`, { fields: MEDIA_FIELDS, limit })).data ?? [];
  const { data: existing } = await admin.from("ig_media").select("id,model_id");
  const linked = new Map((existing ?? []).map((e: any) => [e.id, e.model_id]));
  let n = 0;
  for (const m of list) {
    const r = mediaRow(m, await mediaInsights(m.id, m.media_product_type === "REELS" ? "REELS" : m.media_type));
    if (linked.get(m.id) && !r.model_id) delete r.model_id; // keep manual links
    await admin.from("ig_media").upsert(r, { onConflict: "id" });
    n++;
  }
  return n;
}

// ---------- ads ----------
const STATUS = (c: any) => {
  const s = c.effective_status ?? c.status;
  if (s === "ACTIVE") return "attiva";
  if (c.stop_time && new Date(c.stop_time) < new Date()) return "conclusa";
  return s === "ARCHIVED" || s === "DELETED" ? "conclusa" : "fermata";
};
const msgs = (actions: any[] = []) => {
  const a = actions.find((x) => /messaging_conversation_started/.test(x.action_type));
  return a ? Number(a.value) : null;
};
async function syncAds(full: boolean) {
  let accounts: any[] = [];
  try { accounts = await gAll("/me/adaccounts", { fields: "id,name,currency,account_status" }); }
  catch (e) { return { ad_accounts: 0, error: (e as GErr).message }; }
  let camps = 0;
  const since = addDays(day(new Date()), full ? -180 : -10), until = day(new Date());
  for (const acc of accounts) {
    const list = await gAll(`/${acc.id}/campaigns`, { fields: "id,name,status,effective_status,start_time,stop_time,daily_budget,lifetime_budget,created_time", limit: 100 });
    const tot = await gAll(`/${acc.id}/insights`, { level: "campaign", fields: "campaign_id,spend,impressions,reach,clicks,actions", date_preset: "maximum", limit: 500 });
    const totals = new Map(tot.map((x: any) => [x.campaign_id, x]));
    const ids = new Map<string, number>();
    for (const c of list) {
      const t: any = totals.get(c.id) ?? {};
      const budget = c.lifetime_budget ? Number(c.lifetime_budget) / 100 : null;
      const row: any = {
        meta_id: c.id, name: c.name, platform: "Meta Ads", meta_status: c.effective_status ?? c.status, status: STATUS(c),
        start_date: (c.start_time ?? c.created_time ?? "").slice(0, 10) || null, end_date: c.stop_time ? c.stop_time.slice(0, 10) : null,
        spend: Number(t.spend ?? 0), impressions: t.impressions ? Number(t.impressions) : null, reach: t.reach ? Number(t.reach) : null,
        clicks: t.clicks ? Number(t.clicks) : null, synced_at: new Date().toISOString(),
      };
      const m = msgs(t.actions); if (m != null) row.dms = m;
      if (budget) row.budget = budget;
      const { data: up } = await admin.from("campaigns").upsert(row, { onConflict: "meta_id" }).select("id").single();
      if (up) ids.set(c.id, up.id);
      camps++;
    }
    const daily = await gAll(`/${acc.id}/insights`, { level: "campaign", time_increment: 1, fields: "campaign_id,spend,impressions,reach,clicks,actions,date_start", time_range: { since, until }, limit: 500 }, 30);
    for (const d of daily) {
      const cid = ids.get(d.campaign_id); if (!cid) continue;
      await admin.from("campaign_daily").upsert({ campaign_id: cid, day: d.date_start, spend: Number(d.spend ?? 0), impressions: d.impressions ? Number(d.impressions) : null, reach: d.reach ? Number(d.reach) : null, clicks: d.clicks ? Number(d.clicks) : null, messages: msgs(d.actions) }, { onConflict: "campaign_id,day" });
    }
  }
  return { ad_accounts: accounts.length, campaigns: camps };
}

// ---------- publish ----------
async function waitReady(id: string) {
  for (let i = 0; i < 20; i++) {
    const j = await g(`/${id}`, { fields: "status_code,status" });
    if (j.status_code === "FINISHED") return;
    if (j.status_code === "ERROR" || j.status_code === "EXPIRED") throw new Error("container " + (j.status ?? j.status_code));
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("timeout");
}
async function publish(urls: string[], caption: string, modelId?: number) {
  if (!urls?.length) throw new Error("no_images");
  let creation: string;
  if (urls.length === 1) {
    creation = (await g(`/${IG}/media`, { image_url: urls[0], caption }, "POST")).id;
  } else {
    const kids: string[] = [];
    for (const u of urls.slice(0, 10)) kids.push((await g(`/${IG}/media`, { image_url: u, is_carousel_item: true }, "POST")).id);
    for (const k of kids) await waitReady(k);
    creation = (await g(`/${IG}/media`, { media_type: "CAROUSEL", children: kids.join(","), caption }, "POST")).id;
  }
  await waitReady(creation);
  const pub = await g(`/${IG}/media_publish`, { creation_id: creation }, "POST");
  const m = await g(`/${pub.id}`, { fields: MEDIA_FIELDS });
  const r = mediaRow(m, {}); if (modelId) r.model_id = modelId;
  await admin.from("ig_media").upsert(r, { onConflict: "id" });
  if (modelId) await admin.from("models").update({ instagram_status: "post", instagram_url: m.permalink }).eq("id", modelId);
  return { id: pub.id, permalink: m.permalink };
}

// ---------- direct messages ----------
const MSG_FIELDS = "id,message,from,created_time,attachments{image_data,video_data,file_url,name},shares{link,name},story";
async function linkCustomer(threadId: string, username: string, igUserId: string) {
  if (!username) return null;
  const { data: c } = await admin.from("customers").select("id,ig_user_id").ilike("instagram", username).limit(1).maybeSingle();
  if (!c) return null;
  if (!c.ig_user_id) await admin.from("customers").update({ ig_user_id: igUserId }).eq("id", c.id);
  return c.id;
}
async function syncThread(conv: any, msgs?: any[]) {
  const other = (conv.participants?.data ?? []).find((p: any) => p.id !== IG) ?? {};
  if (!msgs) msgs = (await g(`/${conv.id}`, { fields: `messages.limit(100){${MSG_FIELDS}}` })).messages?.data ?? [];
  const { data: ex } = await admin.from("ig_threads").select("customer_id").eq("id", conv.id).maybeSingle();
  let cust = ex?.customer_id ?? null;
  if (!cust) { const { data: c2 } = await admin.from("customers").select("id").eq("ig_user_id", other.id ?? "-").maybeSingle(); cust = c2?.id ?? await linkCustomer(conv.id, other.username, other.id); }
  const last = msgs[0];
  await admin.from("ig_threads").upsert({ id: conv.id, ig_user_id: other.id ?? null, username: other.username ?? null, customer_id: cust,
    updated_at: conv.updated_time, last_text: last ? (last.message || (last.attachments ? "📎" : last.shares ? "↗" : "")) : null,
    last_from_me: last ? last.from?.id === IG : null, synced_at: new Date().toISOString() }, { onConflict: "id" });
  const rows = msgs.map((m: any) => ({ id: m.id, thread_id: conv.id, from_me: m.from?.id === IG, text: m.message ?? null,
    attachments: m.attachments || m.shares || m.story ? { a: m.attachments?.data ?? null, s: m.shares?.data ?? null, st: m.story ?? null } : null, created_at: m.created_time }));
  if (rows.length) await admin.from("ig_messages").upsert(rows, { onConflict: "id" });
  return cust;
}
async function syncDMs(full: boolean) {
  const { data: known } = await admin.from("ig_threads").select("id,updated_at");
  const k = new Map((known ?? []).map((t: any) => [t.id, t.updated_at ? new Date(t.updated_at).getTime() : 0]));
  const convs = await gAll(`/${IG}/conversations`, { fields: "id,updated_time,participants", limit: 50 }, full ? 6 : 1);
  let n = 0;
  for (const c of convs) {
    if (!full && k.get(c.id) && k.get(c.id)! >= new Date(c.updated_time).getTime()) continue;
    await syncThread(c); n++;
  }
  return { threads: convs.length, updated: n };
}

// ---------- AI customer profile ----------
async function aiProfile(customerId: number) {
  const key = await secret("anthropic_api_key"); if (!key) throw new Error("no_ai_key");
  const { data: c } = await admin.from("customers").select("id,full_name,instagram,phone,country,preferred_lang,notes,created_at").eq("id", customerId).single();
  const { data: th } = await admin.from("ig_threads").select("id").eq("customer_id", customerId);
  const ids = (th ?? []).map((t: any) => t.id);
  const { data: ms } = ids.length ? await admin.from("ig_messages").select("from_me,text,created_at").in("thread_id", ids).order("created_at").limit(400) : { data: [] };
  const { data: ords } = await admin.from("orders").select("order_no,order_date,status,order_lines(qty,unit_price,variants(size,color,models(name,brands(name))))").eq("customer_id", customerId);
  const { data: wl } = await admin.from("wishlist").select("size,color,status,notes,created_at,models(name,brands(name))").eq("customer_id", customerId);
  const chat = (ms ?? []).map((m: any) => `[${String(m.created_at).slice(0, 10)}] ${m.from_me ? "SHOP" : "CLIENT"}: ${m.text ?? "(attachment)"}`).join("\n").slice(-24000);
  const prompt = `You are the CRM assistant of Modus Vestendi, a small online fashion shop (Italian/Spanish brands) selling to Albania, Kosovo, North Macedonia via Instagram.
Build a customer profile ONLY from the data below (Instagram DMs, orders, requests). Do not invent facts; when unknown use null.
Customer: ${JSON.stringify(c)}
Orders: ${JSON.stringify(ords ?? [])}
Requests/wishlist: ${JSON.stringify(wl ?? [])}
DM conversation:
${chat || "(no messages)"}

Answer with ONLY a JSON object, all text values in Italian:
{"summary":"2-3 sentences: who she/he is as a customer and what she/he wants","language":"sq|it|en|...","gender_guess":null,
 "sizes":{"top":null,"bottom":null,"shoes":null,"notes":null},"brands":[],"styles":[],"colors":[],"budget":"e.g. 50-150 € or null",
 "interests":["products or categories asked about"],"open_requests":["things asked and not yet answered/fulfilled"],
 "sentiment":"positivo|neutro|negativo","last_contact":"YYYY-MM-DD or null","next_action":"one concrete suggestion for the shop"}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 6000, messages: [{ role: "user", content: prompt }] }) });
  const j = await r.json(); if (!r.ok) throw new Error(j?.error?.message ?? "ai_error");
  const text = (j.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
  const mt = text.match(/\{[\s\S]*\}/);
  if (!mt) throw new Error("ai_no_json: " + (j.stop_reason ?? "") + " " + text.slice(0, 300));
  const prof = JSON.parse(mt[0]);
  await admin.from("customers").update({ profile_ai: prof, profile_ai_at: new Date().toISOString() }).eq("id", customerId);
  return prof;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const cron = req.headers.get("x-cron-key");
    if (cron) {
      if (cron !== (await secret("cron_key"))) return json({ error: "forbidden" }, 403);
    } else {
      const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
      const roles = ["sync", "media", "comments"].includes(body.action) ? ["admin", "vendite"] : ["admin", "vendite"];
      const { data: ok } = await sb.rpc("has_role", { roles });
      if (!ok) return json({ error: "forbidden" }, 403);
    }
    TOKEN = (await secret("meta_token")) ?? ""; IG = (await secret("ig_user_id")) ?? "";
    if (!TOKEN || !IG) return json({ error: "not_connected" }, 503);

    switch (body.action) {
      case "sync": {
        const out: any = {};
        out.account = await syncAccount(!!body.full).catch((e) => ({ error: e.message }));
        out.media = await syncMedia(body.full ? 100 : 30).catch((e) => ({ error: e.message }));
        out.ads = await syncAds(!!body.full).catch((e) => ({ error: e.message }));
        await admin.from("ig_state").upsert({ k: "last_sync", v: { at: new Date().toISOString(), out }, updated_at: new Date().toISOString() });
        return json(out);
      }
      case "comments": {
        const j = await gAll(`/${body.media_id}/comments`, { fields: "id,text,username,timestamp,like_count,hidden,replies{id,text,username,timestamp,hidden}", limit: 50 }, 3);
        const m = await g(`/${body.media_id}`, { fields: MEDIA_FIELDS });
        const ins = await mediaInsights(m.id, m.media_product_type === "REELS" ? "REELS" : m.media_type);
        await admin.from("ig_media").upsert(mediaRow(m, ins), { onConflict: "id" });
        return json({ comments: j, media: m, insights: ins });
      }
      case "reply": return json(await g(`/${body.comment_id}/replies`, { message: String(body.message ?? "").slice(0, 2000) }, "POST"));
      case "hide": return json(await g(`/${body.comment_id}`, { hide: !!body.hide }, "POST"));
      case "delete_comment": return json(await g(`/${body.comment_id}`, {}, "DELETE"));
      case "dm_sync": return json(await syncDMs(!!body.full));
      case "dm_thread": {
        const conv = await g(`/${body.thread_id}`, { fields: `id,updated_time,participants,messages.limit(100){${MSG_FIELDS}}` });
        await syncThread(conv, conv.messages?.data ?? []);
        await admin.from("ig_threads").update({ read_at: new Date().toISOString() }).eq("id", body.thread_id);
        return json({ ok: true });
      }
      case "dm_send": {
        const { data: t } = await admin.from("ig_threads").select("ig_user_id").eq("id", body.thread_id).single();
        if (!t?.ig_user_id) return json({ error: "no_recipient" }, 400);
        const r = await g(`/${IG}/messages`, { recipient: { id: t.ig_user_id }, message: { text: String(body.text ?? "").slice(0, 1000) } }, "POST");
        const conv = await g(`/${body.thread_id}`, { fields: `id,updated_time,participants,messages.limit(20){${MSG_FIELDS}}` });
        await syncThread(conv, conv.messages?.data ?? []);
        return json(r);
      }
      case "dm_link": {
        const { data: t } = await admin.from("ig_threads").update({ customer_id: body.customer_id ?? null }).eq("id", body.thread_id).select("ig_user_id,username").single();
        if (body.customer_id && t) await admin.from("customers").update({ ig_user_id: t.ig_user_id }).eq("id", body.customer_id).is("ig_user_id", null);
        if (body.customer_id && t?.username) await admin.from("customers").update({ instagram: t.username }).eq("id", body.customer_id).is("instagram", null);
        return json({ ok: true });
      }
      case "profile": return json(await aiProfile(Number(body.customer_id)));
      case "story": {
        const c = await g(`/${IG}/media`, { image_url: body.image_url, media_type: "STORIES" }, "POST");
        await waitReady(c.id);
        const pub = await g(`/${IG}/media_publish`, { creation_id: c.id }, "POST");
        if (body.model_id) await admin.from("models").update({ instagram_status: "storia" }).eq("id", body.model_id).eq("instagram_status", "non_pubblicato");
        return json({ id: pub.id });
      }
      case "publish": return json(await publish(body.image_urls, String(body.caption ?? "").slice(0, 2200), body.model_id));
      default: return json({ error: "unknown_action" }, 400);
    }
  } catch (e) {
    const b = (e as GErr).body;
    return json({ error: "graph", detail: b?.error?.error_user_msg ?? b?.error?.message ?? String((e as Error).message ?? e) }, 502);
  }
});
