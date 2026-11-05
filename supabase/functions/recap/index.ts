// Morning recap email for the Modus Vestendi team: what to do today, from yesterday's DMs and app activity.
// Runs from pg_cron (x-cron-key) at 07:00 and 08:00 UTC and only sends when it is 09:xx in Rome (handles summer time).
// Staff can also call it from the app (admin JWT) with { force: true } or { dry: true } to preview.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const secret = async (n: string) => (await admin.rpc("_secret", { p_name: n })).data as string | null;

const APP = "https://gjorgkodra-hash.github.io/modus-vestendi-app/#/";
const TO = ["joridakodra@modusvestendi.com", "info@modusvestendi.com"];
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const eur = (n: unknown) => n == null ? "—" : new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(Number(n));
const romeParts = (d = new Date()) => Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(d).map((p) => [p.type, p.value]));
const romeDay = (d = new Date()) => { const p = romeParts(d); return `${p.year}-${p.month}-${p.day}`; };
const shift = (s: string, n: number) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fdate = (s: string) => s ? `${s.slice(8, 10)}/${s.slice(5, 7)}` : "";
const daysAgo = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
// Rome midnight of a day, as UTC ISO (approximate offset from the current Rome hour is enough for daily windows)
const romeStart = (day: string) => { const probe = new Date(day + "T12:00:00Z"); const h = Number(romeParts(probe).hour); return new Date(Date.parse(day + "T00:00:00Z") - (h - 12) * 3600e3).toISOString(); };

async function gather() {
  const today = romeDay(), yday = shift(today, -1);
  const from = romeStart(yday), to = romeStart(today);
  const [th, ii, ords, tots, res, wl, newCust, camps, cd, newModels, mov, rsBack, rsNew] = await Promise.all([
    admin.from("ig_threads").select("id,username,customer_id,updated_at,last_text,last_from_me").order("updated_at", { ascending: false }).limit(200),
    admin.from("ig_interest").select("thread_id,customer_id,username,data,last_msg_at"),
    admin.from("orders").select("id,order_no,order_date,status,reserved_until,created_at,customers(id,full_name,instagram)").neq("status", "annullato").order("id", { ascending: false }).limit(300),
    admin.from("v_order_totals").select("order_id,total,to_collect"),
    admin.from("orders").select("id").eq("status", "riservato"),
    admin.from("wishlist").select("id,status,created_at,contacted_at,size,notes,customers(id,full_name),models(id,name,kind,brands(name))").eq("status", "attesa"),
    admin.from("customers").select("id,full_name,instagram,phone,ai_filled,created_at").gte("created_at", from).lt("created_at", to),
    admin.from("campaigns").select("id,name,status,end_date,spend").not("meta_id", "is", null),
    admin.from("campaign_daily").select("campaign_id,day,spend,reach").eq("day", yday),
    admin.from("models").select("id,name,kind,created_at,brands(name)").gte("created_at", from).lt("created_at", to),
    admin.from("stock_movements").select("kind,qty").gte("created_at", from).lt("created_at", to),
    admin.from("restock_requests").select("id,model_id,name,email,phone,emailed_at,variants(size,color),models(name,brands(name))").eq("status", "disponibile").order("available_at"),
    admin.from("restock_requests").select("model_id,variants(size,color),models(name,brands(name))").gte("created_at", from).lt("created_at", to),
  ]);
  const rsLabel = (r: any) => [r.models?.brands?.name?.trim(), r.models?.name].filter(Boolean).join(" ") + " · " + [r.variants?.size, r.variants?.color].filter(Boolean).join(" · ");
  const restockBack = (rsBack.data ?? []).map((r: any) => ({ model_id: r.model_id, item: rsLabel(r), who: r.name || r.email || r.phone, phone: r.phone, emailed: !!r.emailed_at }));
  const rn: Record<string, any> = {}; (rsNew.data ?? []).forEach((r: any) => { const k = rsLabel(r); rn[k] = rn[k] || { item: k, model_id: r.model_id, n: 0 }; rn[k].n++; });
  const restockNew = Object.values(rn).sort((a: any, b: any) => b.n - a.n);
  const I = new Map((ii.data ?? []).map((r: any) => [r.thread_id, r]));
  const T = new Map((tots.data ?? []).map((r: any) => [r.order_id, r]));
  const O = (ords.data ?? []).map((o: any) => ({ ...o, ...(T.get(o.id) ?? {}) }));
  const sum = (r: any) => { const t = String(r?.data?.summary ?? ""); return t.length <= 240 ? t : t.slice(0, 240).replace(/\s+\S*$/, "") + "…"; };

  // 1. clients waiting for an answer (last message is theirs)
  const unanswered = (th.data ?? []).filter((t: any) => t.last_from_me === false && daysAgo(t.updated_at) <= 14).slice(0, 15)
    .map((t: any) => ({ username: t.username, customer_id: t.customer_id, waiting_days: daysAgo(t.updated_at), last: (t.last_text ?? "").slice(0, 120), summary: sum(I.get(t.id)) }));
  // 2. interested people who went quiet after our reply
  const followUp = (ii.data ?? []).filter((r: any) => {
    const d = r.data ?? {}, th1: any = (th.data ?? []).find((t: any) => t.id === r.thread_id);
    const age = d.last_client_msg ? daysAgo(d.last_client_msg) : 99;
    return ["interessato", "trattativa"].includes(d.stage) && age >= 2 && age <= 21 && th1?.last_from_me !== false;
  }).sort((a: any, b: any) => String(b.data.last_client_msg).localeCompare(String(a.data.last_client_msg))).slice(0, 10)
    .map((r: any) => ({ username: r.username, customer_id: r.customer_id, last_msg: r.data.last_client_msg, stage: r.data.stage, summary: sum(r) }));
  // 3. orders
  const toShip = O.filter((o: any) => o.status === "confermato").map((o: any) => ({ id: o.id, no: o.order_no, customer: o.customers?.full_name, total: o.total, to_collect: o.to_collect }));
  const toCollect = O.filter((o: any) => ["spedito", "consegnato"].includes(o.status) && Number(o.to_collect) > 0).map((o: any) => ({ id: o.id, no: o.order_no, customer: o.customers?.full_name, to_collect: o.to_collect, status: o.status }));
  const expiring = O.filter((o: any) => o.status === "riservato" && o.reserved_until && romeDay(new Date(o.reserved_until)) <= today).map((o: any) => ({ id: o.id, no: o.order_no, customer: o.customers?.full_name, until: o.reserved_until }));
  // 4. requests to handle
  const reqs = (wl.data ?? []).map((w: any) => ({ id: w.id, customer: w.customers?.full_name, customer_id: w.customers?.id, product: [w.models?.brands?.name?.trim(), w.models?.name].filter(Boolean).join(" "), model_id: w.models?.id, on_request: w.models?.kind === "ordine", size: w.size, days: daysAgo(w.created_at), contacted: !!w.contacted_at }));
  // 5. asked yesterday but not in stock
  const lost = (ii.data ?? []).flatMap((r: any) => (r.data?.items ?? []).filter((i: any) => i.outcome === "non_disponibile" && i.date >= yday).map((i: any) => ({ username: r.username, ...i }))).slice(0, 12);
  // 6. campaigns
  const cmap = new Map((camps.data ?? []).map((c: any) => [c.id, c]));
  const adsYday = (cd.data ?? []).filter((d: any) => Number(d.spend) > 0).map((d: any) => ({ name: (cmap.get(d.campaign_id) as any)?.name?.replace(/^Instagram post: /, ""), spend: Number(d.spend), reach: d.reach }));
  const ending = (camps.data ?? []).filter((c: any) => c.status === "attiva" && c.end_date && c.end_date <= shift(today, 1)).map((c: any) => ({ name: c.name.replace(/^Instagram post: /, ""), end: c.end_date }));
  const newConv = (ii.data ?? []).filter((r: any) => r.last_msg_at && r.last_msg_at >= from && r.last_msg_at < to).length;
  // 7. app activity yesterday
  const ordY = O.filter((o: any) => o.created_at >= from && o.created_at < to);
  const mv: Record<string, number> = {}; (mov.data ?? []).forEach((m: any) => { mv[m.kind] = (mv[m.kind] ?? 0) + Math.abs(Number(m.qty)); });
  return {
    today, yday, restockBack, restockNew, unanswered, followUp, toShip, toCollect, expiring, reservedOpen: (res.data ?? []).length,
    requests: reqs.filter((r: any) => !r.contacted).slice(0, 12), requestsTotal: reqs.length,
    newCustomers: (newCust.data ?? []).map((c: any) => ({ id: c.id, name: c.full_name, instagram: c.instagram, phone: c.phone, ai: !!c.ai_filled })),
    lost, adsYday, adsSpend: adsYday.reduce((a: number, x: any) => a + x.spend, 0), ending, chatsYday: newConv,
    activity: { orders: ordY.length, revenue: ordY.reduce((a: number, o: any) => a + Number(o.total ?? 0), 0), newProducts: (newModels.data ?? []).map((m: any) => [m.brands?.name?.trim(), m.name].filter(Boolean).join(" ")), movements: mv },
  };
}

async function priorities(key: string, d: any) {
  const slim = { restockBack: d.restockBack.slice(0, 6), unanswered: d.unanswered.slice(0, 8), followUp: d.followUp.slice(0, 6), toShip: d.toShip, toCollect: d.toCollect, expiring: d.expiring, requests: d.requests.slice(0, 6), lost: d.lost.slice(0, 6), ending: d.ending, adsSpend: d.adsSpend, activity: d.activity };
  const prompt = `Sei l'assistente di Modus Vestendi, piccolo negozio online di moda italiana che vende via Instagram in Albania, Kosovo e Macedonia del Nord.
Dati di ieri e cose aperte (JSON): ${JSON.stringify(slim).slice(0, 12000)}
Scrivi in italiano, tono diretto e cordiale, le PRIORITÀ DI OGGI: massimo 5 punti, ognuno una riga breve con nomi concreti (cliente, prodotto, numero ordine). Metti prima quello che porta vendite o evita di perderle. Se non c'è niente di urgente dillo in una riga. Rispondi SOLO con un array JSON di stringhe.`;
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 4000, messages: [{ role: "user", content: prompt }] }) });
  const j = await r.json(); if (!r.ok) throw new Error(j?.error?.message ?? "ai_error");
  const text = (j.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
  const m = text.match(/\[[\s\S]*\]/); return m ? JSON.parse(m[0]) as string[] : [];
}

function html(d: any, pr: string[]) {
  const link = (h: string, label: string) => `<a href="${APP}${h}" style="color:#4a2c25">${label}</a>`;
  const ig = (u: string) => u ? `<a href="https://ig.me/m/${encodeURIComponent(u)}" style="color:#4a2c25">@${esc(u)}</a>` : "";
  const sec = (icon: string, title: string, rows: string[], empty?: string) => rows.length || empty ? `<tr><td style="padding:14px 0 4px"><div style="font:600 15px/1.3 Arial,sans-serif;color:#2b1d19">${icon} ${title}${rows.length ? ` <span style="color:#8a7a72;font-weight:400">(${rows.length})</span>` : ""}</div>
    ${rows.length ? `<ul style="margin:6px 0 0;padding-left:18px;font:14px/1.5 Arial,sans-serif;color:#2b1d19">${rows.map((r) => `<li style="margin:3px 0">${r}</li>`).join("")}</ul>` : `<div style="font:14px Arial,sans-serif;color:#8a7a72;margin-top:4px">${empty}</div>`}</td></tr>` : "";
  const muted = (s: string) => `<span style="color:#8a7a72">${s}</span>`;
  const a = d.activity;
  return `<!doctype html><html><body style="margin:0;background:#efe7df;padding:16px">
<table role="presentation" width="100%" style="max-width:620px;margin:0 auto;background:#fbf8f5;border-radius:12px;padding:20px" cellpadding="0" cellspacing="0">
<tr><td style="font:700 20px Arial,sans-serif;color:#2b1d19">☀️ Buongiorno! Recap di ${fdate(d.today)}</td></tr>
<tr><td style="font:13px Arial,sans-serif;color:#8a7a72;padding-top:2px">Cosa è successo ieri (${fdate(d.yday)}) e cosa fare oggi · Modus Vestendi</td></tr>
${pr.length ? `<tr><td style="padding-top:14px"><div style="background:#f1dfd2;border-radius:10px;padding:12px 14px"><div style="font:600 15px Arial,sans-serif;color:#2b1d19;margin-bottom:4px">🎯 Priorità di oggi</div><ol style="margin:4px 0 0;padding-left:18px;font:14px/1.55 Arial,sans-serif;color:#2b1d19">${pr.map((p) => `<li>${esc(p)}</li>`).join("")}</ol></div></td></tr>` : ""}
${sec("🔔", "Taglie tornate disponibili: contatta chi le aspettava", d.restockBack.map((r: any) => `${link("articolo/" + r.model_id, esc(r.item))} — ${esc(r.who)}${r.phone ? ` ${muted("· " + esc(r.phone))}` : ""} ${muted(r.emailed ? "· email automatica inviata" : "· solo telefono: chiamala/scrivile tu")}`))}
${sec("📝", "Nuove richieste di avviso dal sito (ieri)", d.restockNew.map((r: any) => `${link("articolo/" + r.model_id, esc(r.item))} ${muted("× " + r.n)}`))}
${sec("💬", "Da rispondere", d.unanswered.map((u: any) => `${ig(u.username)} ${muted(`· aspetta da ${u.waiting_days ? u.waiting_days + " g" : "oggi"}`)}<br>${esc(u.summary || u.last)}`), "Nessun cliente in attesa di risposta 👍")}
${sec("🔁", "Da ricontattare (interessati, poi spariti)", d.followUp.map((u: any) => `${ig(u.username)} ${muted(`· ultimo messaggio ${fdate(u.last_msg)}`)}<br>${esc(u.summary)}`))}
${sec("📦", "Da spedire", d.toShip.map((o: any) => `${link("ordine/" + o.id, esc(o.no))} · ${esc(o.customer)} · ${eur(o.total)}${Number(o.to_collect) > 0 ? ` ${muted("· da incassare " + eur(o.to_collect))}` : ""}`))}
${sec("💶", "Da incassare", d.toCollect.map((o: any) => `${link("ordine/" + o.id, esc(o.no))} · ${esc(o.customer)} · <b>${eur(o.to_collect)}</b> ${muted("· " + o.status)}`))}
${sec("⏰", "Prenotazioni che scadono oggi", d.expiring.map((o: any) => `${link("ordine/" + o.id, esc(o.no))} · ${esc(o.customer)}`))}
${sec("🛒", "Richieste da gestire", d.requests.map((r: any) => `${r.model_id ? link("articolo/" + r.model_id, esc(r.product)) : esc(r.product)}${r.size ? " · tg " + esc(r.size) : ""} per ${r.customer_id ? link("cliente/" + r.customer_id, esc(r.customer)) : esc(r.customer)} ${muted(`· ${r.on_request ? "da chiedere al negozio · " : ""}${r.days} g`)}`))}
${sec("💔", "Chiesti ieri ma non li avevamo", d.lost.map((i: any) => `${esc([i.brand, i.what, i.size, i.color].filter(Boolean).join(" · "))}${i.price ? " · " + eur(i.price) : ""} ${muted("— @" + esc(i.username))}`))}
${sec("👤", "Clienti nuovi di ieri", d.newCustomers.map((c: any) => `${link("cliente/" + c.id, esc(c.name))}${c.instagram ? " " + ig(c.instagram) : ""}${c.ai ? ` ${muted("· scheda compilata dall'AI, da controllare")}` : ""}`))}
${sec("📣", "Campagne", [
    d.adsYday.length ? `Ieri spesi <b>${eur(d.adsSpend)}</b>: ${d.adsYday.map((c: any) => `${esc(c.name)} ${eur(c.spend)}`).join(" · ")}` : "",
    ...d.ending.map((c: any) => `Finisce ${c.end === d.today ? "oggi" : "domani"}: ${esc(c.name)} — decidi se rinnovarla (${link("fushata", "risultati")})`),
  ].filter(Boolean))}
<tr><td style="padding:14px 0 4px"><div style="font:600 15px Arial,sans-serif;color:#2b1d19">📊 Ieri in numeri</div>
<div style="font:14px/1.6 Arial,sans-serif;color:#2b1d19">${d.chatsYday} conversazioni attive · ${a.orders} ordini (${eur(a.revenue)})${a.newProducts.length ? ` · ${a.newProducts.length} prodotti nuovi: ${esc(a.newProducts.slice(0, 5).join(", "))}` : ""}${Object.keys(a.movements).length ? ` · movimenti: ${Object.entries(a.movements).map(([k, v]) => `${esc(k)} ${v}`).join(", ")}` : ""} · ${d.requestsTotal} richieste aperte</div></td></tr>
<tr><td style="padding-top:18px"><a href="${APP}" style="display:inline-block;background:#4a2c25;color:#fff;text-decoration:none;font:600 14px Arial,sans-serif;padding:10px 16px;border-radius:8px">Apri l'app</a>
<a href="${APP}tendenca" style="display:inline-block;color:#4a2c25;font:14px Arial,sans-serif;padding:10px 12px">Tendenze e gruppi →</a></td></tr>
<tr><td style="font:12px Arial,sans-serif;color:#8a7a72;padding-top:14px">Recap automatico ogni mattina alle 9:00. Le priorità sono scritte dall'AI sui dati dell'app: controlla sempre prima di agire.</td></tr>
</table></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const cron = req.headers.get("x-cron-key");
    if (cron) { if (cron !== (await secret("cron_key"))) return json({ error: "forbidden" }, 403); }
    else {
      const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
      const { data: ok } = await sb.rpc("has_role", { roles: ["admin"] });
      if (!ok) return json({ error: "forbidden" }, 403);
    }
    // cron fires at 07:00 and 08:00 UTC: send only at 09 Rome time, once per day
    if (!body.force && !body.dry) {
      if (romeParts().hour !== "09") return json({ skipped: "not 9:00 in Rome" });
      const { data: st } = await admin.from("ig_state").select("v").eq("k", "recap").maybeSingle();
      if (st?.v?.day === romeDay()) return json({ skipped: "already sent" });
    }
    const d = await gather();
    const key = await secret("anthropic_api_key");
    let pr: string[] = [];
    if (key) pr = await priorities(key, d).catch(() => []);
    const page = html(d, pr);
    if (body.dry) return new Response(page, { headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" } });
    const rk = await secret("resend_api_key"); if (!rk) return json({ error: "no_resend_key" }, 503);
    const to = Array.isArray(body.to) && body.to.length ? body.to : TO;
    const r = await fetch("https://api.resend.com/emails", { method: "POST",
      headers: { Authorization: `Bearer ${rk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: (await secret("notify_from")) ?? "Modus Vestendi <noreply@updates.modusvestendi.com>", to, reply_to: "info@modusvestendi.com",
        subject: `☀️ Recap ${fdate(d.today)}: ${d.unanswered.length} da rispondere, ${d.toShip.length} da spedire`, html: page }) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: "resend", detail: out }, 502);
    await admin.from("ig_state").upsert({ k: "recap", v: { day: d.today, at: new Date().toISOString(), to, id: out.id, priorities: pr }, updated_at: new Date().toISOString() });
    return json({ sent: true, id: out.id, to, priorities: pr });
  } catch (e) {
    return json({ error: "server", detail: String((e as Error).message ?? e) }, 500);
  }
});
