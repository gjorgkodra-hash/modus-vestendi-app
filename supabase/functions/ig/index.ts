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
    : ["reach,views,saved,shares,total_interactions,follows,profile_visits", "reach,views,saved,shares,total_interactions", "reach,saved,total_interactions", "reach"];
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
    follows: ins.follows ?? null, profile_visits: ins.profile_visits ?? null,
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
  if (c.stop_time && new Date(c.stop_time) < new Date()) return "conclusa";
  if (s === "ACTIVE") return "attiva";
  return s === "ARCHIVED" || s === "DELETED" ? "conclusa" : "fermata";
};
const act = (actions: any[] = [], re: RegExp) => { const a = actions.find((x) => re.test(x.action_type)); return a ? Number(a.value) : null; };
const msgs = (actions: any[] = []) => {
  const a = actions.find((x) => /messaging_conversation_started/.test(x.action_type));
  return a ? Number(a.value) : null;
};
let mainTokCache = "", adsTokCache = "";
async function syncAds(full: boolean) {
  const adsTok = await secret("meta_ads_token"), mainTok = TOKEN;
  mainTokCache = mainTok; adsTokCache = adsTok ?? "";
  if (adsTok) {
    TOKEN = adsTok;
    try {
      const d = (await g("/debug_token", { input_token: adsTok })).data ?? {};
      await admin.from("ig_state").upsert({ k: "ads_token", v: { valid: d.is_valid, expires_at: d.expires_at ? new Date(d.expires_at * 1000).toISOString() : null }, updated_at: new Date().toISOString() });
    } catch (e) { await admin.from("ig_state").upsert({ k: "ads_token", v: { valid: false, error: (e as Error).message }, updated_at: new Date().toISOString() }); }
  }
  try { return await syncAdsInner(full); } finally { TOKEN = mainTok; }
}
async function syncAdsInner(full: boolean) {
  let accounts: any[] = [];
  try { accounts = await gAll("/me/adaccounts", { fields: "id,name,currency,account_status" }); }
  catch (e) { return { ad_accounts: 0, error: (e as GErr).message }; }
  let camps = 0;
  const since = addDays(day(new Date()), full ? -180 : -10), until = day(new Date());
  for (const acc of accounts) {
    const list = await gAll(`/${acc.id}/campaigns`, { fields: "id,name,status,effective_status,start_time,stop_time,daily_budget,lifetime_budget,created_time", limit: 100 });
    const tot = await gAll(`/${acc.id}/insights`, { level: "campaign", fields: "campaign_id,spend,impressions,reach,frequency,clicks,inline_link_clicks,ctr,cpm,cpc,actions", date_preset: "maximum", limit: 500 });
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
        frequency: t.frequency ? Number(t.frequency) : null, link_clicks: t.inline_link_clicks ? Number(t.inline_link_clicks) : null,
        engagement: act(t.actions, /^post_engagement$/), calls: act(t.actions, /^call_confirm_grouped$|click_to_call/),
        metrics: { ctr: t.ctr ? Number(t.ctr) : null, cpm: t.cpm ? Number(t.cpm) : null, cpc: t.cpc ? Number(t.cpc) : null,
          reactions: act(t.actions, /^post_reaction$|^like$/), photo_views: act(t.actions, /^photo_view$/), video_views: act(t.actions, /^video_view$/),
          saves: act(t.actions, /post_save/), shares: act(t.actions, /^post$/), profile_visits: act(t.actions, /profile_visit/), follows: act(t.actions, /follow/),
          actions: t.actions ?? [] },
      };
      const m = msgs(t.actions); if (m != null) row.dms = m;
      if (budget) row.budget = budget;
      const { data: up } = await admin.from("campaigns").upsert(row, { onConflict: "meta_id" }).select("id").single();
      if (up) ids.set(c.id, up.id);
      camps++;
    }
    // which Instagram post each campaign boosts (to read that post's own follows)
    try {
      const ads = await gAll(`/${acc.id}/ads`, { fields: "campaign_id,creative{effective_instagram_media_id}", limit: 200 }, 5);
      const byCamp = new Map<string, string>();
      for (const a of ads) { const mid = a.creative?.effective_instagram_media_id; if (mid && !byCamp.has(a.campaign_id)) byCamp.set(a.campaign_id, mid); }
      const { data: have } = await admin.from("ig_media").select("id,follows,synced_at");
      const known = new Map((have ?? []).map((m: any) => [m.id, m]));
      for (const [cmeta, mid] of byCamp) {
        const cid = ids.get(cmeta); if (!cid) continue;
        await admin.from("campaigns").update({ ig_media_id: mid }).eq("id", cid);
        const k: any = known.get(mid);
        if (!k) { // sponsored posts: Instagram gives only reach/saves, so fetch once
          try {
            TOKEN = mainTokCache;
            const m = await g(`/${mid}`, { fields: MEDIA_FIELDS });
            await admin.from("ig_media").upsert(mediaRow(m, await mediaInsights(m.id, m.media_product_type === "REELS" ? "REELS" : m.media_type)), { onConflict: "id" });
          } catch (_) { /* post deleted or not ours */ } finally { TOKEN = adsTokCache || TOKEN; }
        }
      }
    } catch (_) { /* ads list not readable */ }
    const daily = await gAll(`/${acc.id}/insights`, { level: "campaign", time_increment: 1, fields: "campaign_id,spend,impressions,reach,clicks,inline_link_clicks,actions,date_start", time_range: { since, until }, limit: 500 }, 30);
    for (const d of daily) {
      const cid = ids.get(d.campaign_id); if (!cid) continue;
      await admin.from("campaign_daily").upsert({ campaign_id: cid, day: d.date_start, spend: Number(d.spend ?? 0), impressions: d.impressions ? Number(d.impressions) : null, reach: d.reach ? Number(d.reach) : null, clicks: d.clicks ? Number(d.clicks) : null, messages: msgs(d.actions), link_clicks: d.inline_link_clicks ? Number(d.inline_link_clicks) : null, engagement: act(d.actions, /^post_engagement$/) }, { onConflict: "campaign_id,day" });
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
  for (const m of msgs) {
    const rt = m.story?.reply_to;
    if (rt?.id) await saveStory(rt.id, rt.link ?? null, { ts: m.created_time });
  }
  return cust;
}
async function syncDMs(full: boolean) {
  const { data: known } = await admin.from("ig_threads").select("id,updated_at");
  const k = new Map((known ?? []).map((t: any) => [t.id, t.updated_at ? new Date(t.updated_at).getTime() : 0]));
  // full = walk back through all pages; either way only new/changed conversations are downloaded,
  // and we stop before the function time limit (the next run continues where this one stopped)
  const convs = await gAll(`/${IG}/conversations`, { fields: "id,updated_time,participants", limit: 50 }, full ? 30 : 1);
  let n = 0, left = 0; const t0 = Date.now();
  for (const c of convs) {
    if (k.get(c.id) && k.get(c.id)! >= new Date(c.updated_time).getTime()) continue;
    if (Date.now() - t0 > 100000) { left++; continue; }
    await syncThread(c); n++;
  }
  return { threads: convs.length, updated: n, left };
}

// ---------- stories ----------
async function saveStory(id: string, url: string | null, extra: any = {}) {
  const { data: ex } = await admin.from("ig_stories").select("id,image_path").eq("id", id).maybeSingle();
  if (ex?.image_path) return;
  let path: string | null = null;
  if (url) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const buf = new Uint8Array(await r.arrayBuffer());
        path = `ig_stories/${id}.jpg`;
        const up = await admin.storage.from("foto").upload(path, buf, { contentType: r.headers.get("content-type") ?? "image/jpeg", upsert: true });
        if (up.error) path = null;
      }
    } catch (_) { /* image not reachable anymore */ }
  }
  await admin.from("ig_stories").upsert({ id, image_path: path, ...extra }, { onConflict: "id" });
}
async function syncStories() {
  const list = (await g(`/${IG}/stories`, { fields: "id,media_type,media_url,thumbnail_url,permalink,timestamp" })).data ?? [];
  for (const s of list) await saveStory(s.id, s.media_type === "VIDEO" ? s.thumbnail_url : s.media_url, { media_type: s.media_type, ts: s.timestamp, permalink: s.permalink });
  return list.length;
}
async function storyAI(id: string) {
  const key = await secret("anthropic_api_key"); if (!key) throw new Error("no_ai_key");
  const { data: st } = await admin.from("ig_stories").select("image_path").eq("id", id).single();
  if (!st?.image_path) throw new Error("no_image");
  const { data: file } = await admin.storage.from("foto").download(st.image_path);
  const bytes = new Uint8Array(await file!.arrayBuffer());
  let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const { data: brands } = await admin.from("brands").select("name");
  const { data: cats } = await admin.from("categories").select("id,name");
  const prompt = `This is an Instagram story of Modus Vestendi, a fashion reseller. It shows ONE clothing/shoe/bag item, often with brand and price written on it.
Known brands: ${(brands ?? []).map((b: any) => b.name).join(", ")}
Categories (id: name): ${(cats ?? []).map((c: any) => c.id + ": " + c.name).join("; ")}
Answer with ONLY JSON: {"brand":"brand name as written or recognised, or null","name":"short Italian product name, e.g. Cappotto lungo in lana","category_id":number or null,
"gender":"donna|uomo|bambini|unisex","color":"main colour in Italian","price":number or null (price written on the story, EUR),"sizes":["sizes written on the story"],"text_on_image":"other text visible","description":"1 sentence in Italian"}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 4000, messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: btoa(bin) } }, { type: "text", text: prompt }] }] }) });
  const j = await r.json(); if (!r.ok) throw new Error(j?.error?.message ?? "ai_error");
  const text = (j.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
  const mt = text.match(/\{[\s\S]*\}/); if (!mt) throw new Error("ai_no_json");
  const ai = JSON.parse(mt[0]);
  await admin.from("ig_stories").update({ ai }).eq("id", id);
  return ai;
}

// ---------- AI interests from DM conversations ----------
const normLink = (u: string) => String(u ?? "").split("?")[0].replace(/\/$/, "");
async function analyzeThread(key: string, th: any, msgs: any[], ctx: any) {
  const lines = msgs.map((m: any) => {
    const parts: string[] = [];
    if (m.text) parts.push(m.text);
    const a = m.attachments ?? {};
    for (const sh of a.s ?? []) {
      const md = ctx.media.get(normLink(sh.link));
      parts.push(md ? `[shared our post${md.model_id ? ` model_id=${md.model_id}` : ""}: ${String(md.caption ?? "").slice(0, 120)}]` : `[shared a post ${sh.name ?? ""}]`);
    }
    const st = a.st?.reply_to?.id ? ctx.stories.get(a.st.reply_to.id) : null;
    if (a.st?.reply_to) parts.push(st ? `[reply to our story${st.model_id ? ` model_id=${st.model_id}` : ""}${st.ai ? `: ${[st.ai.brand, st.ai.name, st.ai.price ? st.ai.price + "€" : ""].filter(Boolean).join(" ")}` : ""}]` : "[reply to our story]");
    if (!parts.length && a.a) parts.push("[photo/attachment]");
    return `[${String(m.created_at).slice(0, 10)}] ${m.from_me ? "SHOP" : "CLIENT"}: ${parts.join(" ")}`;
  }).join("\n").slice(-20000);
  const prompt = `You analyse Instagram DM conversations of Modus Vestendi, a small online shop selling Italian/Spanish fashion brands (mostly women) to Albania, Kosovo, North Macedonia. Messages are mostly in Albanian.
Known brands: ${ctx.brands.join(", ")}
Categories (id: name): ${ctx.cats}
Our products (model_id: brand name price): ${ctx.models}
Conversation with @${th.username ?? "?"}:
${lines}

Extract ONLY what the conversation says; use null when unknown. Answer with ONLY JSON:
{"summary":"1 sentence in Italian: who and what she/he wants","intent":"acquisto|informazioni|post_vendita|altro",
"stage":"curioso|interessato|trattativa|acquistato|perso","gender":"donna|uomo|null","country":"AL|XK|MK|IT|UK|other|null",
"sizes":{"top":null,"bottom":null,"shoes":null},"budget_max":null,
"items":[{"brand":"brand exactly as in the known list, or other name, or null","category_id":null,"what":"short Italian, e.g. cappotto lungo nero","size":null,"color":null,"price":null,"model_id":null,"date":"YYYY-MM-DD","outcome":"chiesto|non_disponibile|ordinato|rifiutato_prezzo|in_attesa"}],
"brands":["brands she/he likes"],"category_ids":[],"styles":["e.g. elegante, casual, classico"],"objections":["prezzo|taglia|spedizione|tempi|qualita|pagamento"],
"last_client_msg":"YYYY-MM-DD or null",
"contact":{"full_name":"name and surname the CLIENT gave for delivery, or null","phone":"phone number the CLIENT wrote, with country prefix if given, or null","email":null,
 "address":{"line1":"street / neighbourhood","city":null,"zip":null,"country":"AL|XK|MK|IT|UK|other|null"},"height_cm":null,"weight_kg":null,"bust_cm":null,"waist_cm":null,"hips_cm":null,"shoe_size":null,"brand_sizes":{"brand":"size she/he wears in that brand"},"notes":"other fit info the client gave (e.g. wears 44 in jackets, wide foot), or null"}}
For "contact" use only data the CLIENT wrote about herself/himself (not the shop's data).`;
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 6000, messages: [{ role: "user", content: prompt }] }) });
  const j = await r.json(); if (!r.ok) throw new Error(j?.error?.message ?? "ai_error");
  const text = (j.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
  const mt = text.match(/\{[\s\S]*\}/); if (!mt) throw new Error("ai_no_json");
  return JSON.parse(mt[0]);
}
async function interests(limit = 12, force = false) {
  const key = await secret("anthropic_api_key"); if (!key) throw new Error("no_ai_key");
  const [{ data: th }, { data: done }, { data: stats }] = await Promise.all([
    admin.from("ig_threads").select("id,username,customer_id"),
    admin.from("ig_interest").select("thread_id,msg_count"),
    admin.rpc("ig_thread_stats")]);
  const doneMap = new Map((done ?? []).map((d: any) => [d.thread_id, d.msg_count]));
  const st = new Map((stats ?? []).map((x: any) => [x.thread_id, x]));
  const todo = (th ?? []).filter((t: any) => { const s: any = st.get(t.id); return s && s.client_msgs > 0 && (force || doneMap.get(t.id) !== s.n); })
    .sort((a: any, b: any) => String((st.get(b.id) as any).last).localeCompare(String((st.get(a.id) as any).last))).slice(0, limit);
  if (!todo.length) return { analyzed: 0, left: 0 };
  const [{ data: media }, { data: stories }, { data: brands }, { data: cats }, { data: models }] = await Promise.all([
    admin.from("ig_media").select("permalink,caption,model_id"), admin.from("ig_stories").select("id,model_id,ai"),
    admin.from("brands").select("name"), admin.from("categories").select("id,name"),
    admin.from("models").select("id,name,list_price,brands(name)").eq("archived", false)]);
  const ctx = { media: new Map((media ?? []).map((m: any) => [normLink(m.permalink), m])), stories: new Map((stories ?? []).map((s: any) => [s.id, s])),
    brands: (brands ?? []).map((b: any) => b.name.trim()), cats: (cats ?? []).map((c: any) => `${c.id}: ${c.name}`).join("; "),
    models: (models ?? []).map((m: any) => `${m.id}: ${m.brands?.name?.trim() ?? ""} ${m.name} ${m.list_price ?? ""}€`).join("; ") };
  let ok = 0; const errors: string[] = [];
  for (let i = 0; i < todo.length; i += 4) {
    await Promise.all(todo.slice(i, i + 4).map(async (t: any) => {
      try {
        const { data: msgs } = await admin.from("ig_messages").select("from_me,text,attachments,created_at").eq("thread_id", t.id).order("created_at");
        const data = await analyzeThread(key, t, msgs ?? [], ctx);
        const s: any = st.get(t.id);
        const cid = await applyContact(t, data).catch(() => t.customer_id);
        await admin.from("ig_interest").upsert({ thread_id: t.id, customer_id: cid ?? t.customer_id, username: t.username, data, msg_count: s.n, last_msg_at: s.last, analyzed_at: new Date().toISOString() }, { onConflict: "thread_id" });
        ok++;
      } catch (e) { errors.push(`${t.username}: ${(e as Error).message}`); }
    }));
  }
  const left = (th ?? []).filter((t: any) => { const s: any = st.get(t.id); return s && s.client_msgs > 0 && doneMap.get(t.id) !== s.n; }).length - ok;
  return { analyzed: ok, left: Math.max(0, left), errors };
}

// fill the customer card from what the client wrote; never overwrites values already there
const clean = (v: any) => v == null || String(v).trim() === "" || String(v).toLowerCase() === "null" ? null : String(v).trim();
async function applyContact(t: any, d: any) {
  const c = d?.contact ?? {}, a = c.address ?? {};
  const phone = clean(c.phone)?.replace(/[^\d+]/g, "") || null, name = clean(c.full_name), line1 = clean(a.line1), city = clean(a.city);
  const country = ["AL", "XK", "MK", "IT", "UK"].includes(String(a.country ?? d.country)) ? (a.country ?? d.country) : null;
  const sizes: any = {}; for (const k of ["top", "bottom", "shoes"]) if (clean(d.sizes?.[k])) sizes[k] = clean(d.sizes[k]);
  if (clean(c.shoe_size) && !sizes.shoes) sizes.shoes = clean(c.shoe_size);
  const height = Number(c.height_cm) > 100 && Number(c.height_cm) < 220 ? Math.round(Number(c.height_cm)) : null;
  const weight = Number(c.weight_kg) > 30 && Number(c.weight_kg) < 200 ? Number(c.weight_kg) : null;
  let cid = t.customer_id;
  if (!cid) {
    if (!phone && !(line1 || city)) return null; // only people who gave delivery data become customers
    const { data: nc } = await admin.from("customers").insert({ full_name: name || t.username, instagram: t.username, phone, country, source: "instagram_organico", preferred_lang: "sq", ai_filled: { created: true, at: new Date().toISOString() } }).select("id").single();
    if (!nc) return null;
    cid = nc.id;
    await admin.from("ig_threads").update({ customer_id: cid }).eq("id", t.id);
    const { data: th } = await admin.from("ig_threads").select("ig_user_id").eq("id", t.id).single();
    if (th?.ig_user_id) await admin.from("customers").update({ ig_user_id: th.ig_user_id }).eq("id", cid);
  }
  const { data: cu } = await admin.from("customers").select("*").eq("id", cid).single();
  if (!cu) return cid;
  const up: any = {}, filled: string[] = [];
  const set = (k: string, v: any) => { if (v != null && (cu[k] == null || cu[k] === "" || (k === "full_name" && cu[k] === cu.instagram))) { up[k] = v; filled.push(k); } };
  set("phone", phone); set("email", clean(c.email)); set("country", country);
  if (name && /\s/.test(name)) set("full_name", name);
  // body data and sizes go to the measurements card (only empty fields are filled)
  const cm = (v: any, lo: number, hi: number) => Number(v) > lo && Number(v) < hi ? Number(v) : null;
  const bs: any = {}; for (const [b, z] of Object.entries(c.brand_sizes ?? {})) if (b !== "brand" && clean(z)) bs[b] = clean(z);
  if (sizes.bottom) bs["Pantaloni / gonne"] = sizes.bottom;
  const mv: any = { height_cm: height, weight_kg: weight, bust_cm: cm(c.bust_cm, 50, 160), waist_cm: cm(c.waist_cm, 40, 150), hips_cm: cm(c.hips_cm, 50, 170), shoe_size: sizes.shoes ?? null, usual_size: sizes.top ?? null };
  if (Object.values(mv).some((v) => v != null) || Object.keys(bs).length || clean(c.notes)) {
    const { data: ex } = await admin.from("customer_measurements").select("*").eq("customer_id", cid).order("taken_on", { ascending: false }).limit(1).maybeSingle();
    if (!ex) {
      await admin.from("customer_measurements").insert({ customer_id: cid, ...mv, brand_sizes: bs, notes: ["AI (Instagram)", clean(c.notes)].filter(Boolean).join(": ") });
      filled.push("measurements");
    } else {
      const mu: any = {}; for (const [k, v] of Object.entries(mv)) if (v != null && ex[k] == null) mu[k] = v;
      const nb = { ...bs, ...(ex.brand_sizes ?? {}) }; if (JSON.stringify(nb) !== JSON.stringify(ex.brand_sizes ?? {})) mu.brand_sizes = nb;
      if (clean(c.notes) && !(ex.notes ?? "").includes(clean(c.notes)!)) mu.notes = [ex.notes, "AI: " + clean(c.notes)].filter(Boolean).join(" · ");
      if (Object.keys(mu).length) { await admin.from("customer_measurements").update(mu).eq("id", ex.id); filled.push("measurements"); }
    }
  }
  if (filled.length) { up.ai_filled = { ...(cu.ai_filled ?? {}), fields: [...new Set([...(cu.ai_filled?.fields ?? []), ...filled])], at: new Date().toISOString() }; await admin.from("customers").update(up).eq("id", cid); }
  if (line1 || city) {
    const { data: ad } = await admin.from("addresses").select("id,line1,city").eq("customer_id", cid);
    const same = (ad ?? []).some((x: any) => (x.line1 ?? "").toLowerCase() === (line1 ?? "").toLowerCase() && (x.city ?? "").toLowerCase() === (city ?? "").toLowerCase());
    if (!same) await admin.from("addresses").insert({ customer_id: cid, label: "Instagram (AI)", line1, city, zip: clean(a.zip), country, is_default: !(ad ?? []).length });
  }
  return cid;
}

// ---------- AI promo message for a customer group ----------
async function promoText(body: any) {
  const key = await secret("anthropic_api_key"); if (!key) throw new Error("no_ai_key");
  const prompt = `You write Instagram DM messages for Modus Vestendi, a small online shop of Italian fashion brands (Albania, Kosovo, North Macedonia).
Customer group: ${String(body.group ?? "").slice(0, 400)}
Products to propose: ${JSON.stringify(body.products ?? []).slice(0, 3000)}
Write a short, warm, personal DM (max 450 characters) in ${body.lang === "it" ? "Italian" : body.lang === "en" ? "English" : "Albanian"} that a shop owner would send by hand: greet, say we thought of her/him because of what she/he likes, name the product(s) with price, invite to reply for size/photos. Use {name} where the first name goes. No hashtags, max 1 emoji. Answer with ONLY the message text.`;
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 3000, messages: [{ role: "user", content: prompt }] }) });
  const j = await r.json(); if (!r.ok) throw new Error(j?.error?.message ?? "ai_error");
  return { text: (j.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("").trim() };
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
      case "dm_sync": {
        const stories = await syncStories().catch((e) => ({ error: e.message }));
        return json({ stories, ...(await syncDMs(!!body.full)) });
      }
      case "ads": return json(await syncAds(!!body.full));
      case "story_ai": return json(await storyAI(String(body.story_id)));
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
      case "interests": return json(await interests(Math.min(Number(body.limit) || 12, 30), !!body.force));
      case "promo_text": return json(await promoText(body));
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
