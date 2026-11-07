// Blog drafts for Modus Vestendi, in Albanian. Nothing is published here: the app saves the draft and staff review it.
// kinds: trend (from an outlet's article link: our own words + credit, never a translation), guida_taglie (brand size guide),
// stile (how to wear), brand (brand story), cura (garment care), novita (new arrivals).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const KINDS = ["trend", "guida_taglie", "stile", "brand", "cura", "novita"];

const decode = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;|&rsquo;|&lsquo;/g, "'")
  .replace(/&ldquo;|&rdquo;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
const meta = (h: string, ...names: string[]) => {
  for (const n of names) {
    const m = h.match(new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']+)["']`, "i")) || h.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${n}["']`, "i"));
    if (m) return decode(m[1]).trim();
  }
  return null;
};
// read the source article ourselves: title, outlet, author, date and the plain text
async function readSource(url: string) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; ModusVestendiBot/1.0; +https://shop.modusvestendi.com)", "Accept-Language": "it,en;q=0.8" }, redirect: "follow" });
  if (!r.ok) throw new Error(`source_http_${r.status}`);
  const h = await r.text();
  let ld: any = null;
  for (const m of h.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const j = JSON.parse(m[1]); const arr = Array.isArray(j) ? j : j["@graph"] ?? [j]; ld = arr.find((x: any) => /Article|BlogPosting|NewsArticle/.test(String(x?.["@type"]))) ?? ld; } catch (_) { /* ignore */ }
  }
  const auth = ld?.author ? (Array.isArray(ld.author) ? ld.author : [ld.author]).map((a: any) => typeof a === "string" ? a : a?.name).filter(Boolean).join(", ") : null;
  const body = (h.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? h.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? h)
    .replace(/<(script|style|noscript|svg|figure|figcaption|nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|h[1-6]|li|blockquote)>/gi, "\n").replace(/<[^>]+>/g, " ");
  const text = decode(body).split("\n").map((x) => x.replace(/\s+/g, " ").trim()).filter((x) => x.length > 40).join("\n").slice(0, 30000);
  return {
    url, text,
    title: decode(String(ld?.headline ?? meta(h, "og:title", "twitter:title") ?? h.match(/<title>([^<]*)/i)?.[1] ?? "")).trim(),
    name: decode(String(ld?.publisher?.name ?? meta(h, "og:site_name") ?? new URL(url).hostname.replace(/^www\./, ""))),
    author: auth ? decode(auth) : meta(h, "author", "article:author", "parsely-author"),
    date: (ld?.datePublished ?? meta(h, "article:published_time", "date", "parsely-pub-date") ?? "").slice(0, 10) || null,
  };
}

async function claude(key: string, model: string, prompt: string, search = 0, maxTokens = 12000) {
  let messages: any[] = [{ role: "user", content: prompt }], res: any = null;
  for (let i = 0; i < 3; i++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages, ...(search ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: search }] } : {}) }),
    });
    res = await r.json();
    if (!r.ok) throw new Error(res?.error?.message ?? "ai_error");
    if (res.stop_reason !== "pause_turn") break;
    messages = [...messages, { role: "assistant", content: res.content }];
  }
  const text = (res.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("ai_no_json");
  return { out: JSON.parse(m[0]), usage: res.usage };
}

// same-language overlap: share of 8-word sequences of the draft that also appear in the source
function overlap(src: string, draft: string) {
  const w = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const a = w(src), b = w(draft); if (b.length < 8) return 0;
  const S = new Set<string>(); for (let i = 0; i + 8 <= a.length; i++) S.add(a.slice(i, i + 8).join(" "));
  let hit = 0, n = 0; for (let i = 0; i + 8 <= b.length; i++) { n++; if (S.has(b.slice(i, i + 8).join(" "))) hit++; }
  return n ? hit / n : 0;
}
const blocksText = (blocks: any[]) => (blocks ?? []).map((b: any) => [b.text, ...(b.items ?? []), ...((b.rows ?? []).flat())].filter(Boolean).join(" ")).join("\n");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const cron = req.headers.get("x-cron-key");
    if (cron) { if (cron !== (await admin.rpc("_secret", { p_name: "cron_key" })).data) return json({ error: "forbidden" }, 403); }
    else {
      const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
      const { data: ok } = await sb.rpc("has_role", { roles: ["admin", "vendite", "magazzino"] });
      if (!ok) return json({ error: "forbidden" }, 403);
    }
    const key = Deno.env.get("ANTHROPIC_API_KEY") || (await admin.rpc("_secret", { p_name: "anthropic_api_key" })).data;
    if (!key) return json({ error: "no_key" }, 503);
    const body = await req.json();
    const kind = KINDS.includes(body.kind) ? body.kind : "trend";
    const notes = String(body.notes ?? "").slice(0, 2000);
    const warnings: string[] = [];

    // our catalogue: the only products the article may suggest
    const { data: cat } = await admin.rpc("shop_catalog");
    const P = (cat ?? []) as any[];
    const brand = body.brand ? String(body.brand) : null;
    const line = (p: any) => {
      const av = p.variants.filter((v: any) => v.available > 0);
      const price = Math.min(...(av.length ? av : p.variants).map((v: any) => Number(v.price)));
      return `${p.id} | ${p.brand ?? ""} | ${p.name} | ${p.category?.it ?? ""} | ${p.gender ?? ""} | colori: ${[...new Set(p.variants.map((v: any) => v.color).filter(Boolean))].join("/")} | taglie disponibili: ${[...new Set(av.map((v: any) => v.size))].join(" ") || "ESAURITO"} | ${price}€${Number(p.list_price) > price ? ` (listino ${p.list_price}€)` : ""}${p.details?.composition ? " | " + p.details.composition : ""}${p.details?.fit ? " | vestibilità " + p.details.fit : ""}`;
    };
    const catalog = P.map(line).join("\n");

    let src: any = null;
    if (kind === "trend") {
      if (!body.url) return json({ error: "missing_url" }, 400);
      try { src = await readSource(String(body.url)); } catch (e) { return json({ error: "source_unreadable", detail: (e as Error).message }, 422); }
      if (src.text.length < 1200) return json({ error: "source_unreadable", detail: "paywall_or_blocked", source: { ...src, text: undefined } }, 422);
    }

    const shape = `Answer with ONLY one JSON object:
{"title": "titull në shqip, max 70 shenja", "excerpt": "1-2 fjali, max 160 shenja", "seo_title": "max 60 shenja", "seo_desc": "max 155 shenja",
 "blocks": [ {"t":"p","text":"..."}, {"t":"h","text":"nëntitull"}, {"t":"list","items":["..."]}, {"t":"tip","text":"këshillë e shkurtër"},
             {"t":"table","rows":[["kolona 1","kolona 2"],["...","..."]]}, {"t":"quote","text":"citim i shkurtër","cite":"burimi"}, {"t":"products","title":"Bli trendin","ids":[123,456]} ],
 "product_ids": [3 to 6 ids from OUR CATALOGUE that really match the topic; prefer items with available sizes],
 "cover_product_id": one of product_ids whose photo fits as cover,
 "ig_slides": [ {"kind":"cover","title":"max 8 fjalë","text":"max 12 fjalë"}, {"kind":"text","title":"max 6 fjalë","text":"max 30 fjalë"} (4-6 of these, one idea each),
                {"kind":"product","product_id":id,"text":"max 15 fjalë"} (1-2), {"kind":"end","title":"max 6 fjalë","text":"max 20 fjalë"} ],
 "ig_caption": "first 125 characters are the hook; then 2-4 short lines; CTA to the blog link in bio / DM; 3-5 relevant hashtags at the end; max 1200 characters",
 "warnings": ["anything the editor must check, in Italian, e.g. data you could not verify"]}`;
    const style = `You are the editor of the blog of Modus Vestendi, a small online shop of original Italian/Spanish fashion brands (mostly women) for Albania, Kosovo and North Macedonia; payment on delivery; site shop.modusvestendi.com.
Write in natural, correct standard Albanian (as used by Albanian fashion magazines), warm and practical, addressing the reader with "ju". No invented facts, prices or statistics. Prices only from OUR CATALOGUE.
Product suggestions: use ONLY ids from OUR CATALOGUE below; never invent products. If nothing fits, return an empty list and say so in warnings.
OUR CATALOGUE (id | brand | name | category | gender | colours | sizes in stock | price | details):
${catalog}
${notes ? `\nEditor's notes (follow them): ${notes}` : ""}`;

    let prompt = "", search = 0;
    if (kind === "trend") {
      prompt = `${style}

SOURCE ARTICLE (from ${src.name}${src.author ? ", by " + src.author : ""}${src.date ? ", " + src.date : ""}): "${src.title}"
---
${src.text}
---
Write an ORIGINAL article inspired by this source, NOT a translation:
- 300-500 words, your own structure and wording; summarise the key trend points in your own words and add our angle: how to wear it in Albania/Kosovo, in daily life, with the pieces we sell.
- Never translate or closely paraphrase sentences or paragraphs of the source. At most ONE short quote (max 25 words) as a "quote" block with "cite" = the outlet name.
- Mention the outlet by name in the text once (e.g. "Sipas ${src.name}, ..."). The source credit box is added automatically: do not add links.
- Add a "products" block near the end with the matching products.
${shape}`;
    } else {
      const topics: Record<string, string> = { guida_taglie: `a SIZE GUIDE for the brand ${brand ?? "(the brand in the notes)"}: how its sizes run (Italian numeric sizes vs S/M/L, true to size or not), a conversion table (IT / EU-FR / international S-M-L / bust-waist-hips in cm) taken from the brand's OFFICIAL size chart, how to measure yourself, tips per garment type (coats, knitwear, trousers), and that customers can send us height and weight on DM for advice. Use web search to find the official ${brand ?? ""} size chart and say in warnings which page you used. If you cannot verify a number, leave it out and add a warning.`,
        stile: "a STYLING article (how to wear / combine) built around our products",
        brand: `a BRAND STORY of ${brand ?? "the brand in the notes"}: origins, style, signature pieces, why it is valued; use web search for verified facts only and list in warnings what you used`,
        cura: "a GARMENT CARE guide (wool, cashmere, down jackets, leather...) with practical steps; use web search to verify care rules",
        novita: "a NEW ARRIVALS article presenting our newest products in stock" };
      const topic = topics[kind];
      search = ["guida_taglie", "brand", "cura"].includes(kind) ? 5 : 0;
      prompt = `${style}

Write ${topic}. 350-600 words, with sub-headings. Add a "products" block with matching products.${kind === "guida_taglie" && brand ? ` Prefer products of ${brand}.` : ""}
${shape}`;
    }
    const { out, usage } = await claude(key, Deno.env.get("AI_MODEL") || "claude-sonnet-5-5", prompt, search);

    // keep only real product ids
    const ids = new Set(P.map((p) => p.id));
    out.product_ids = (out.product_ids ?? []).map(Number).filter((i: number) => ids.has(i)).slice(0, 6);
    for (const b of out.blocks ?? []) if (b.t === "products") b.ids = (b.ids ?? []).map(Number).filter((i: number) => ids.has(i));
    out.ig_slides = (out.ig_slides ?? []).filter((s: any) => s.kind !== "product" || ids.has(Number(s.product_id)));
    const cover = P.find((p) => p.id === Number(out.cover_product_id) && p.photos?.length) ?? P.find((p) => out.product_ids.includes(p.id) && p.photos?.length);
    out.cover_path = cover?.photos?.[0] ?? null;
    const text = [out.title, out.excerpt, blocksText(out.blocks)].join("\n");
    out.reading_min = Math.max(1, Math.round(text.split(/\s+/).length / 200));
    out.warnings = [...(out.warnings ?? []), ...warnings];

    // originality check against the source (trend articles)
    if (src) {
      const same = overlap(src.text, text);
      let judge: any = { score: same, passages: [] };
      try {
        const j = await claude(key, "claude-haiku-5-5", `Compare a SOURCE article and a DRAFT (the draft is in Albanian, the source may be in another language).
Is the draft a translation or close paraphrase of the source (same sentences in the same order), or an original text that only takes facts/ideas from it?
SOURCE:\n${src.text.slice(0, 12000)}\n\nDRAFT:\n${text}\n
Answer ONLY JSON: {"score": 0.0-1.0 (1 = translation/close paraphrase), "passages": ["draft sentences that are too close to the source, max 5"]}`, 0, 2000);
        judge = j.out;
      } catch (_) { /* keep the same-language score */ }
      out.similarity = Math.max(same, Number(judge.score) || 0);
      out.similar_passages = judge.passages ?? [];
      if (out.similarity > 0.35) out.warnings.push("Il testo è troppo vicino all'articolo originale: riscrivi i passaggi segnalati prima di pubblicare.");
      out.source = { url: src.url, name: src.name, author: src.author, date: src.date, title: src.title };
    }
    out.kind = kind;
    out.usage = usage;
    if (body.save) { // store as a draft (never published from here)
      const { data: row, error } = await admin.from("blog_posts").insert({ status: "bozza", category: kind, title: out.title ?? "", excerpt: out.excerpt ?? null, body: out.blocks ?? [],
        cover_path: out.cover_path, product_ids: out.product_ids, source: out.source ?? null, similarity: out.similarity ?? null, seo_title: out.seo_title ?? null, seo_desc: out.seo_desc ?? null,
        reading_min: out.reading_min, ig_slides: out.ig_slides ?? [], ig_caption: out.ig_caption ?? null,
        ai: { kind, notes, brand, url: body.url ?? null, warnings: out.warnings, similar_passages: out.similar_passages ?? [], usage }, created_by: null }).select("id").single();
      if (error) return json({ error: "save", detail: error.message }, 500);
      out.id = row.id;
    }
    return json(out);
  } catch (e) {
    return json({ error: "server", detail: String((e as Error)?.message ?? e) }, 500);
  }
});
