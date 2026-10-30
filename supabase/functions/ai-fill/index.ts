// AI auto-fill of product details + market price range (Anthropic API with web search).
// Only staff with admin/magazzino role can call it. Nothing is saved here: the app shows
// the proposal and the user decides what to keep.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const ENUMS: Record<string, string[]> = {
  fit: ["aderente", "regular", "loose", "oversize"],
  silhouette: ["diritta", "avvitata", "svasata", "trapezio", "sirena", "ampia"],
  length: ["corta", "normale", "lunga", "midi", "maxi", "cropped"],
  sleeve: ["lunghe", "tre_quarti", "corte", "senza"],
  neckline: ["tondo", "v", "alto", "dolcevita", "camicia", "revers", "barca", "spalle", "quadrato", "cappuccio"],
  structure: ["maglia", "tessuto", "jersey", "denim", "tweed", "pelle", "camoscio", "pizzo", "velluto", "raso", "paillettes"],
  care: ["mano", "lavatrice30", "lavatrice40", "delicato", "secco", "non_lavare"],
  closure: ["zip", "bottoni", "lacci", "velcro", "fibbia", "senza"],
};
const TR = ["composition", "lining", "padding", "details", "measures", "upper", "sole"];
const FREE = [...TR, ...TR.map((k) => k + "_sq"), ...TR.map((k) => k + "_en"), "style_code", "heel"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    let key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) {
      const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      key = (await admin.rpc("_secret", { p_name: "anthropic_api_key" })).data ?? undefined;
    }
    if (!key) return json({ error: "no_key" }, 503);
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: ok } = await sb.rpc("has_role", { roles: ["admin", "magazzino"] });
    if (!ok) return json({ error: "forbidden" }, 403);

    const { model_id, hint } = await req.json();
    const { data: m, error } = await sb.from("models")
      .select("id,name,season,description,list_price,gender,details,brands(name),categories(name),variants(color,size)")
      .eq("id", model_id).single();
    if (error || !m) return json({ error: "not_found", detail: error?.message }, 404);

    const colors = [...new Set((m.variants ?? []).map((v: any) => v.color).filter(Boolean))];
    const sizes = [...new Set((m.variants ?? []).map((v: any) => v.size).filter(Boolean))];
    const product = {
      brand: (m as any).brands?.name, name: m.name, category: (m as any).categories?.name, gender: m.gender,
      season: m.season, colors, sizes, our_description: m.description, our_price_eur: m.list_price,
      user_hint: hint || null,
    };

    const prompt = `You help a small online fashion shop (Modus Vestendi, sells to Albania, Kosovo, North Macedonia) fill in product data.
Product from our inventory (JSON): ${JSON.stringify(product)}

1. Use web search to find THIS exact product (brand + model name + colour; the user hint may be a style code or a link) on the brand's official site and on retailers (e.g. Zalando, Farfetch, YOOX, Mytheresa, brand stores). Prefer the official site.
2. Extract the product details. Only fill a field when a source states it or it is clearly visible from the product description; otherwise leave it out. Never guess composition.
3. Collect current selling prices in EUR (full price and, separately, sale price if discounted) from up to 6 different sellers.
4. For every text field among ${JSON.stringify(TR)} that you fill, ALSO give its Albanian version as "<field>_sq" and English version as "<field>_en" (correct, natural Albanian fashion terms). Write only product facts: no notes about sources or uncertainty inside the fields.
5. Write a short original product description (2-3 sentences, do not copy text from websites) in Italian, Albanian and English.

Answer with ONLY one JSON object, no other text, in this shape:
{"found": true|false, "match": "exact"|"similar"|"none", "match_note": "short note in Italian about how sure you are / what you matched",
 "details": { /* only known fields */
   ${Object.entries(ENUMS).map(([k, v]) => `"${k}": one of ${JSON.stringify(v)}`).join(",\n   ")},
   "composition": "e.g. 70% lana, 30% poliammide (write in Italian)", "lining": "Italian", "padding": "Italian",
   "details": "Italian, short, e.g. tasche laterali, spacco posteriore", "style_code": "brand article code if found",
   "measures": "Italian, e.g. Lunghezza 70 cm sulla taglia M", "heel": "e.g. 8 cm", "upper": "Italian", "sole": "Italian",
   "details_sq": "Albanian", "details_en": "English", "composition_sq": "Albanian", "composition_en": "English" /* same for every text field you fill */ },
 "description": {"it": "...", "sq": "...", "en": "..."},
 "prices": [{"seller": "...", "url": "...", "price": 0, "sale_price": null, "currency": "EUR"}],
 "price_range": {"min": 0, "max": 0, "typical": 0, "currency": "EUR", "note": "short note in Italian"},
 "sources": ["url", "..."]}`;

    let messages: any[] = [{ role: "user", content: prompt }];
    let res: any = null;
    for (let i = 0; i < 3; i++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: Deno.env.get("AI_MODEL") || "claude-sonnet-5-5",
          max_tokens: 4000,
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
          messages,
        }),
      });
      res = await r.json();
      if (!r.ok) return json({ error: "ai_error", detail: res?.error?.message ?? r.status }, 502);
      if (res.stop_reason !== "pause_turn") break;
      messages = [...messages, { role: "assistant", content: res.content }];
    }
    const text = (res.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    const mt = text.match(/\{[\s\S]*\}/);
    if (!mt) return json({ error: "bad_answer", detail: text.slice(0, 300) }, 502);
    const out = JSON.parse(mt[0]);

    const d: Record<string, string> = {};
    for (const [k, v] of Object.entries(out.details ?? {})) {
      if (v == null || String(v).trim() === "") continue;
      if (ENUMS[k]) { if (ENUMS[k].includes(String(v))) d[k] = String(v); }
      else if (FREE.includes(k)) d[k] = String(v).trim().slice(0, 400);
    }
    out.details = d;
    out.usage = { ...res.usage };
    return json(out);
  } catch (e) {
    return json({ error: "server", detail: String((e as any)?.message ?? e) }, 500);
  }
});
