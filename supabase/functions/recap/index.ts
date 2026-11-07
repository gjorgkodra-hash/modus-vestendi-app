// Morning recap email for the Modus Vestendi team: orders/shipments to check, customers to contact by reason, yesterday's money.
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

const OK_ST = ["confermato", "spedito", "consegnato", "reso"];
// same formula as the Reports page: sales by order date; costs counted only from the app's data start
async function finance(a: string, b: string, dataStart: string) {
  if (b < dataStart) return null;
  if (a < dataStart) a = dataStart;
  const [L, E, C, D] = await Promise.all([
    admin.from("v_line_margins").select("order_id,qty,gross,discount_share,landed_cost,shipping_share,margin").in("status", OK_ST).gte("order_date", a).lte("order_date", b),
    admin.from("expenses").select("amount").gte("expense_date", a).lte("expense_date", b),
    admin.from("campaign_daily").select("spend").gte("day", a).lte("day", b),
    admin.from("defects").select("qty,unit_cost,refund_amount").in("status", ["rimborsato", "perso", "coupon"]).gte("resolved_on", a).lte("resolved_on", b),
  ]);
  const l = L.data ?? [], n = (x: unknown) => Number(x ?? 0);
  const gross = l.reduce((s, x: any) => s + n(x.gross), 0), disc = l.reduce((s, x: any) => s + n(x.discount_share), 0);
  const cogs = l.reduce((s, x: any) => s + n(x.qty) * n(x.landed_cost), 0), ship = l.reduce((s, x: any) => s + n(x.shipping_share), 0);
  const margin = l.reduce((s, x: any) => s + n(x.margin), 0);
  const exp = (E.data ?? []).reduce((s, x: any) => s + n(x.amount), 0), camp = (C.data ?? []).reduce((s, x: any) => s + n(x.spend), 0);
  const loss = (D.data ?? []).reduce((s, x: any) => s + Math.max(0, n(x.qty) * n(x.unit_cost) - n(x.refund_amount)), 0);
  return { orders: new Set(l.map((x: any) => x.order_id)).size, pieces: l.reduce((s, x: any) => s + n(x.qty), 0), net: gross - disc, cogs, ship, margin, exp, camp, loss, profit: margin - exp - camp - loss };
}

async function gather() {
  const today = romeDay(), yday = shift(today, -1), month = today.slice(0, 8) + "01";
  const { data: ds } = await admin.from("app_settings").select("v").eq("k", "data_start").maybeSingle();
  const dataStart = String(ds?.v ?? "2000-01-01").replace(/"/g, "");
  const [ords, tots, ships, fb, th, wl, rsBack, rsNew, pays] = await Promise.all([
    admin.from("orders").select("id,order_no,order_date,status,reserved_until,shipped_at,delivered_at,created_at,customers(id,full_name,instagram,phone)").not("status", "in", "(annullato,bozza)").order("id", { ascending: false }).limit(300),
    admin.from("v_order_totals").select("order_id,total,to_collect"),
    admin.from("shipments").select("order_id,tracking_no,status,shipped_on,carriers(name)"),
    admin.from("order_feedback").select("order_id"),
    admin.from("ig_threads").select("id,username,customer_id,updated_at,last_text,last_from_me").order("updated_at", { ascending: false }).limit(200),
    admin.from("wishlist").select("id,status,created_at,asked_on,expected_on,size,color,order_line_id,customers(id,full_name,instagram,phone),models(id,name,kind,brands(name)),suppliers(name)").in("status", ["attesa", "chiesto", "confermato", "non_disponibile"]),
    admin.from("restock_requests").select("id,model_id,name,email,phone,emailed_at,size,color,height_cm,weight_kg,variants(size,color),models(name,brands(name))").eq("status", "disponibile").order("available_at"),
    admin.from("restock_requests").select("id").gte("created_at", romeStart(yday)).lt("created_at", romeStart(today)),
    admin.from("payments").select("amount,kind,status,paid_on").eq("paid_on", yday),
  ]);
  const T = new Map((tots.data ?? []).map((r: any) => [r.order_id, r]));
  const SH = new Map((ships.data ?? []).map((r: any) => [r.order_id, r]));
  const FB = new Set((fb.data ?? []).map((r: any) => r.order_id));
  const O = (ords.data ?? []).map((o: any) => ({ ...o, ...(T.get(o.id) ?? {}), ship: SH.get(o.id) }));
  const who = (c: any) => c?.full_name || (c?.instagram ? "@" + c.instagram : "—");
  const prod = (m: any) => [m?.brands?.name?.trim(), m?.name].filter(Boolean).join(" ");
  const base = (o: any) => ({ id: o.id, no: o.order_no, customer: who(o.customers), total: o.total, to_collect: Number(o.to_collect ?? 0) });

  // 1. orders and shipments
  const toShip = O.filter((o: any) => o.status === "confermato").map((o: any) => ({ ...base(o), days: daysAgo(o.created_at) }));
  const inTransit = O.filter((o: any) => o.status === "spedito").map((o: any) => ({ ...base(o), days: o.shipped_at ? daysAgo(o.shipped_at) : null, carrier: o.ship?.carriers?.name, tracking: o.ship?.tracking_no }))
    .sort((a: any, b: any) => (b.days ?? 0) - (a.days ?? 0));
  const noOutcome = O.filter((o: any) => o.status === "consegnato" && !FB.has(o.id) && o.delivered_at && daysAgo(o.delivered_at) <= 10).map(base);
  const expiring = O.filter((o: any) => o.status === "riservato" && o.reserved_until && romeDay(new Date(o.reserved_until)) <= shift(today, 1)).map((o: any) => ({ ...base(o), until: o.reserved_until }));
  const toCollect = O.filter((o: any) => o.status === "consegnato" && Number(o.to_collect) > 0).map(base);

  // 2. customers to contact, by reason (facts only, no AI interpretation)
  // a last message that only says thanks / ok / an emoji does not need an answer
  const THANKS = /(faleminderit|flm|rrofsh|thnx|thx|thanks|thank you|grazie|e vler[eë]soj|ju lumt)/i;
  const OKS = /^(ok|okay|okey|oki|po+|fix|mir[eë]|dakord|sigurisht|perfekt|perfetto|super|top|bravo|ne rregull|n[eë] rregull)$/i;
  const closing = (x: string) => {
    if (/[📎↗]/u.test(x) || x.includes("?") || /(m[eë] thoni|m[eë] tregoni|m[eë] lajm[eë]roni|fammi sapere|let me know)/i.test(x)) return false; // "tell me": she waits for us
    const plain = x.replace(/\p{Extended_Pictographic}|️|[!.,;:]/gu, " ").replace(/\s+/g, " ").trim();
    if (!plain) return true; // only emoji
    return (THANKS.test(plain) && plain.length <= 60) || OKS.test(plain);
  };
  const waiting = (th.data ?? []).filter((t: any) => t.last_from_me === false && daysAgo(t.updated_at) <= 14 && !(t.last_text && closing(String(t.last_text))))
    .map((t: any) => ({ username: t.username, customer_id: t.customer_id, days: daysAgo(t.updated_at), last: String(t.last_text ?? "").slice(0, 110) }));
  const W = (wl.data ?? []).map((w: any) => ({ id: w.id, customer: who(w.customers), customer_id: w.customers?.id, phone: w.customers?.phone, product: prod(w.models), model_id: w.models?.id,
    size: w.size, color: w.color, days: daysAgo(w.created_at), expected: w.expected_on, supplier: w.suppliers?.name, status: w.status, exchange: !!w.order_line_id, onReq: w.models?.kind === "ordine" }));
  const askShop = W.filter((w) => w.status === "attesa" && (w.exchange || w.onReq));
  const waitShop = W.filter((w) => w.status === "chiesto");
  const tellYes = W.filter((w) => w.status === "confermato");
  const tellNo = W.filter((w) => w.status === "non_disponibile");
  const rsLabel = (r: any) => [r.models?.brands?.name?.trim(), r.models?.name].filter(Boolean).join(" ") + " · " + [r.size || (r.height_cm ? `taglia da consigliare (${r.height_cm} cm, ${r.weight_kg ?? "?"} kg)` : r.variants?.size), r.color || r.variants?.color].filter(Boolean).join(" · ");
  const restockBack = (rsBack.data ?? []).map((r: any) => ({ model_id: r.model_id, item: rsLabel(r), who: r.name || r.email || r.phone, phone: r.phone, emailed: !!r.emailed_at }));

  // 3. money
  const fy = await finance(yday, yday, dataStart), fm = await finance(month, yday, dataStart);
  const cashIn = (pays.data ?? []).filter((p: any) => p.kind !== "rimborso" && ["incassato", "consegnato_dal_corriere"].includes(p.status)).reduce((s: number, p: any) => s + Number(p.amount), 0);
  const refunds = (pays.data ?? []).filter((p: any) => p.kind === "rimborso").reduce((s: number, p: any) => s + Math.abs(Number(p.amount)), 0);
  return { today, yday, month, toShip, inTransit, noOutcome, expiring, toCollect, waiting, askShop, waitShop, tellYes, tellNo, restockBack, restockNewN: (rsNew.data ?? []).length, fy, fm, cashIn, refunds };
}

function html(d: any) {
  const link = (h: string, label: string) => `<a href="${APP}${h}" style="color:#4a2c25">${label}</a>`;
  const ig = (u: string) => u ? `<a href="https://ig.me/m/${encodeURIComponent(u)}" style="color:#4a2c25">@${esc(u)}</a>` : "";
  const muted = (s: string) => `<span style="color:#8a7a72">${s}</span>`;
  const H = (icon: string, title: string) => `<tr><td style="padding:20px 0 2px;font:700 17px Arial,sans-serif;color:#2b1d19;border-bottom:2px solid #e6d9cf">${icon} ${title}</td></tr>`;
  const sec = (title: string, rows: string[], note = "") => rows.length ? `<tr><td style="padding:10px 0 2px"><div style="font:600 14.5px Arial,sans-serif;color:#2b1d19">${title} <span style="color:#8a7a72;font-weight:400">(${rows.length})</span></div>${note ? `<div style="font:12.5px Arial,sans-serif;color:#8a7a72">${note}</div>` : ""}
    <ul style="margin:4px 0 0;padding-left:18px;font:14px/1.5 Arial,sans-serif;color:#2b1d19">${rows.map((r) => `<li style="margin:3px 0">${r}</li>`).join("")}</ul></td></tr>` : "";
  const none = (txt: string) => `<tr><td style="padding:8px 0;font:14px Arial,sans-serif;color:#8a7a72">${txt}</td></tr>`;
  const ord = (o: any) => `${link("ordine/" + o.id, esc(o.no))} · ${esc(o.customer)} · ${eur(o.total)}`;
  const req = (w: any) => `${w.model_id ? link("articolo/" + w.model_id, esc(w.product)) : esc(w.product)}${w.size ? " · tg " + esc(w.size) : ""}${w.color ? " · " + esc(w.color) : ""} — ${w.customer_id ? link("cliente/" + w.customer_id, esc(w.customer)) : esc(w.customer)}`;
  const p1 = [...d.toShip, ...d.inTransit, ...d.noOutcome, ...d.expiring, ...d.toCollect].length;
  const p2 = [...d.waiting, ...d.askShop, ...d.waitShop, ...d.tellYes, ...d.tellNo, ...d.restockBack].length;
  const row = (label: string, v: number | null | undefined, mv: number | null | undefined, opt: { bold?: boolean; minus?: boolean; color?: string; mcolor?: string } = {}) =>
    `<tr><td style="padding:5px 0;border-bottom:1px solid #eee4dc;font:${opt.bold ? "700" : "400"} 14px Arial,sans-serif;color:#2b1d19">${opt.minus ? "− " : ""}${label}</td>
     <td style="padding:5px 0 5px 10px;border-bottom:1px solid #eee4dc;text-align:right;font:${opt.bold ? "700" : "400"} 14px Arial,sans-serif;color:${opt.color ?? "#2b1d19"};white-space:nowrap">${v == null ? "—" : eur(v)}</td>
     <td style="padding:5px 0 5px 10px;border-bottom:1px solid #eee4dc;text-align:right;font:${opt.bold ? "700" : "400"} 14px Arial,sans-serif;color:${opt.mcolor ?? opt.color ?? "#2b1d19"};white-space:nowrap">${mv == null ? "—" : eur(mv)}</td></tr>`;
  const fin = () => {
    const y = d.fy, m = d.fm;
    if (!y && !m) return none("Nessun dato.");
    const lines: [string, string, any][] = [["Fatturato netto", "net", {}], ["Costo merce", "cogs", { minus: true }], ["Spedizione e dazi", "ship", { minus: true }], ["Margine lordo", "margin", { bold: true }],
      ["Spese", "exp", { minus: true }], ["Campagne", "camp", { minus: true }], ["Perdite per difetti", "loss", { minus: true }], ["Utile netto", "profit", { bold: true }]];
    const pct = (x: any) => x && x.net ? ` <span style="font-weight:400;color:#8a7a72">${Math.round(x.margin / x.net * 100)}%</span>` : "";
    return `<tr><td style="padding:8px 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td></td><td style="text-align:right;font:600 12px Arial,sans-serif;color:#8a7a72;padding-bottom:4px">IERI ${fdate(d.yday)}</td><td style="text-align:right;font:600 12px Arial,sans-serif;color:#8a7a72;padding:0 0 4px 10px">MESE (dal ${fdate(d.month)})</td></tr>
      ${lines.map(([l, k, o]) => row(l + (k === "margin" ? pct(y) : ""), y ? y[k] : null, m ? m[k] : null,
        { ...o, ...(k === "profit" ? { color: (y?.profit ?? 0) >= 0 ? "#2e7d4f" : "#b3261e", mcolor: (m?.profit ?? 0) >= 0 ? "#2e7d4f" : "#b3261e" } : {}) })).join("")}
      <tr><td colspan="3" style="padding-top:6px;font:13px Arial,sans-serif;color:#8a7a72">Ieri: ${y?.orders ?? 0} ordini · ${y?.pieces ?? 0} pezzi · incassati ${eur(d.cashIn)}${d.refunds ? ` · rimborsi ${eur(d.refunds)}` : ""} · mese: ${m?.orders ?? 0} ordini</td></tr></table></td></tr>`;
  };
  return `<!doctype html><html><body style="margin:0;background:#efe7df;padding:16px">
<table role="presentation" width="100%" style="max-width:620px;margin:0 auto;background:#fbf8f5;border-radius:12px;padding:20px" cellpadding="0" cellspacing="0">
<tr><td style="font:700 20px Arial,sans-serif;color:#2b1d19">☀️ Buongiorno! Recap di ${fdate(d.today)}</td></tr>
<tr><td style="font:13px Arial,sans-serif;color:#8a7a72;padding-top:2px">Dati dell'app al momento dell'invio · Modus Vestendi</td></tr>

${H("📦", "Ordini e spedizioni da controllare")}
${p1 ? "" : none("Niente da controllare 👍")}
${sec("Da spedire", d.toShip.map((o: any) => `${ord(o)} ${muted(`· confermato da ${o.days ? o.days + " g" : "oggi"}`)}${o.to_collect > 0 ? ` ${muted("· contrassegno " + eur(o.to_collect))}` : ""}`))}
${sec("Spediti: controlla se sono stati consegnati", d.inTransit.map((o: any) => `${ord(o)} ${muted(`· spedito ${o.days == null ? "" : o.days ? "da " + o.days + " g" : "oggi"}${o.carrier ? " · " + esc(o.carrier) : ""}${o.tracking ? " · " + esc(o.tracking) : ""}`)}${(o.days ?? 0) >= 4 ? ` <b style="color:#b3261e">· in ritardo?</b>` : ""}`))}
${sec("Prenotazioni che scadono oggi o domani", d.expiring.map((o: any) => `${ord(o)} ${muted("· scade " + fdate(romeDay(new Date(o.until))))}`))}
${sec("Consegnati: chiedi com'è andata", d.noOutcome.map(ord), "Segna l'esito nell'ordine (tutto ok, reso, cambio taglia).")}
${sec("Consegnati ma non ancora incassati", d.toCollect.map((o: any) => `${link("ordine/" + o.id, esc(o.no))} · ${esc(o.customer)} · <b>${eur(o.to_collect)}</b>`))}

${H("👥", "Clienti da contattare")}
${p2 ? "" : none("Nessun cliente da contattare 👍")}
${sec("In attesa di una risposta in DM", d.waiting.map((u: any) => `${ig(u.username)} ${muted(`· scrive da ${u.days ? u.days + " g" : "oggi"}`)}<br>${muted(u.last ? "«" + esc(u.last) + "»" : "(senza testo: reazione o risposta a una storia)")}`))}
${sec("Da chiedere al fornitore / al negozio", d.askShop.map((w: any) => `${req(w)} ${muted(`· ${w.exchange ? "cambio" : "su richiesta"} · ${w.days ? "da " + w.days + " g" : "da oggi"}`)}`))}
${sec("In attesa della risposta del fornitore", d.waitShop.map((w: any) => `${req(w)} ${muted(`${w.supplier ? "· " + esc(w.supplier) : ""}${w.expected ? " · arrivo previsto " + fdate(w.expected) : ""}`)}`))}
${sec("Da avvisare: il pezzo c'è", d.tellYes.map((w: any) => `${req(w)}${w.phone ? " " + muted("· " + esc(w.phone)) : ""}`))}
${sec("Da avvisare: non disponibile (rimborso)", d.tellNo.map((w: any) => `${req(w)}${w.phone ? " " + muted("· " + esc(w.phone)) : ""}`))}
${sec("Taglie tornate disponibili (richieste dal sito)", d.restockBack.map((r: any) => `${link("articolo/" + r.model_id, esc(r.item))} — ${esc(r.who)}${r.phone ? " " + muted("· " + esc(r.phone)) : ""} ${muted(r.emailed ? "· email automatica inviata" : "· solo telefono: contattala tu")}`))}
${d.restockNewN ? `<tr><td style="padding:8px 0 0;font:13px Arial,sans-serif;color:#8a7a72">📝 Ieri ${d.restockNewN} nuove richieste "avvisami" dal sito.</td></tr>` : ""}

${H("💶", "Recap finanziario")}
${fin()}

<tr><td style="padding-top:20px"><a href="${APP}" style="display:inline-block;background:#4a2c25;color:#fff;text-decoration:none;font:600 14px Arial,sans-serif;padding:10px 16px;border-radius:8px">Apri l'app</a>
<a href="${APP}report" style="display:inline-block;color:#4a2c25;font:14px Arial,sans-serif;padding:10px 12px">Report completo →</a></td></tr>
<tr><td style="font:12px Arial,sans-serif;color:#8a7a72;padding-top:14px">Recap automatico ogni mattina alle 9:00, fatto solo con i dati dell'app (ordini, spedizioni, richieste, DM non risposti, conto economico). Le spese delle campagne Meta possono arrivare con qualche ora di ritardo.</td></tr>
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
    const page = html(d);
    if (body.dry) return new Response(page, { headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" } });
    const rk = await secret("resend_api_key"); if (!rk) return json({ error: "no_resend_key" }, 503);
    const to = Array.isArray(body.to) && body.to.length ? body.to : TO;
    const r = await fetch("https://api.resend.com/emails", { method: "POST",
      headers: { Authorization: `Bearer ${rk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: (await secret("notify_from")) ?? "Modus Vestendi <noreply@updates.modusvestendi.com>", to, reply_to: "info@modusvestendi.com",
        subject: `☀️ Recap ${fdate(d.today)}: ${d.toShip.length} da spedire, ${d.inTransit.length} in viaggio, ${d.waiting.length} DM da rispondere · ieri ${eur(d.fy?.net ?? 0)}`, html: page }) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: "resend", detail: out }, 502);
    await admin.from("ig_state").upsert({ k: "recap", v: { day: d.today, at: new Date().toISOString(), to, id: out.id }, updated_at: new Date().toISOString() });
    return json({ sent: true, id: out.id, to });
  } catch (e) {
    return json({ error: "server", detail: String((e as Error).message ?? e) }, 500);
  }
});
