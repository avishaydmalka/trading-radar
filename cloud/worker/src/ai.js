/**
 * AI + market data helpers for the Worker:
 *  - llmCall: free-tier LLM (user's own key or the shared key, with a fair daily budget)
 *  - liveLookup: price history + indicators for any ticker (Yahoo Finance), for stocks nobody tracks
 *  - recommend / ask: per-stock recommendation (JSON) and free-text Q&A (Hebrew)
 */

const GEMINI_MODELS = ["gemini-3.5-flash", "gemini-flash-latest", "gemini-flash-lite-latest"];
const GROQ_MODELS = ["openai/gpt-oss-120b", "llama-3.1-8b-instant"];
const MAX_REQUESTS_PER_CALL = 4;
const QA_DAILY_PER_USER = 25; // questions per day on the shared key (own key: unlimited by us)

const clean = (s) => String(s ?? "").trim();
const today = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ budget */
export async function aiAccess(env, user, users) {
  const own = (await env.RADAR.get(`llm_keys:${user.id}`, "json")) || {};
  const hasOwn = Object.values(own).some((v) => clean(v));
  if (hasOwn) return { mode: "own", keys: { gemini: clean(own.gemini), groq: clean(own.groq), openrouter: clean(own.openrouter) } };
  const keys = { gemini: clean(env.GEMINI_API_KEY), groq: clean(env.GROQ_API_KEY), openrouter: clean(env.OPENROUTER_API_KEY) };
  if (!Object.values(keys).some(Boolean)) return { mode: "none", error: "אין מפתח AI במערכת – הוסף מפתח אישי ב'החשבון שלי'" };
  const daily = +(env.SHARED_LLM_DAILY_CALLS || 300);
  let nShared = 0;
  for (const u of users) {
    const k = (await env.RADAR.get(`llm_keys:${u.id}`, "json")) || {};
    if (!Object.values(k).some((v) => clean(v))) nShared++;
  }
  const share = Math.max(1, Math.floor(daily / Math.max(1, nShared)));
  let usage = (await env.RADAR.get("llm_usage", "json")) || {};
  if (usage.date !== today()) usage = { date: today(), total: 0, users: {} };
  const used = usage.users?.[user.id] || 0;
  const qa = usage.qa_users?.[user.id] || 0;
  if (usage.total >= daily) return { mode: "shared", error: "המכסה היומית של המפתח המשותף נוצלה – נסה מחר או הוסף מפתח אישי" };
  if (used >= share) return { mode: "shared", error: `ניצלת את ${share} בקשות ה‑AI היומיות שלך מהמפתח המשותף – נסה מחר או הוסף מפתח אישי` };
  if (qa >= QA_DAILY_PER_USER) return { mode: "shared", error: `הגעת ל‑${QA_DAILY_PER_USER} שאלות היום על המפתח המשותף – הוסף מפתח אישי לשאלות בלי הגבלה` };
  return { mode: "shared", keys, left: Math.min(share - used, daily - usage.total) };
}

export async function recordUsage(env, user, access, requests, kind) {
  if (access.mode !== "shared" || !requests) return;
  let usage = (await env.RADAR.get("llm_usage", "json")) || {};
  if (usage.date !== today()) usage = { date: today(), total: 0, users: {} };
  usage.total = (usage.total || 0) + requests;
  usage.users = usage.users || {};
  usage.users[user.id] = (usage.users[user.id] || 0) + requests;
  usage[kind] = (usage[kind] || 0) + requests;
  if (kind === "qa") {
    usage.qa_users = usage.qa_users || {};
    usage.qa_users[user.id] = (usage.qa_users[user.id] || 0) + 1;
  }
  await env.RADAR.put("llm_usage", JSON.stringify(usage));
}

/* ------------------------------------------------------------------ LLM */
function errMsg(text) {
  try { const e = JSON.parse(text).error; return String(e?.message || e || text).slice(0, 140); } catch (e) { return String(text).slice(0, 140); }
}

export async function llmCall(env, keys, { system, prompt, json = false, maxRequests = MAX_REQUESTS_PER_CALL }) {
  let requests = 0;
  const errors = [];
  if (keys.gemini) {
    const state = (await env.RADAR.get("llm_state", "json")) || {};
    const models = [...new Set([state.gemini_good, ...GEMINI_MODELS].filter(Boolean))];
    for (const model of models) {
      if (requests >= maxRequests - (keys.groq ? 1 : 0)) break;
      requests++;
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": keys.gemini },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 4096, ...(json ? { responseMimeType: "application/json" } : {}) },
        }),
      }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
      if (!r.ok) { errors.push(`gemini ${model}: ${r.status} ${errMsg(await r.text())}`); if (r.status === 400 || r.status === 403) break; continue; }
      const data = await r.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      const text = parts.filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
      if (text) return { text, provider: `gemini:${model}`, requests };
      errors.push(`gemini ${model}: empty answer`);
    }
  }
  const compat = [
    keys.groq && { name: "groq", base: "https://api.groq.com/openai/v1", key: keys.groq, models: GROQ_MODELS },
    keys.openrouter && { name: "openrouter", base: "https://openrouter.ai/api/v1", key: keys.openrouter, models: ["meta-llama/llama-3.3-70b-instruct:free"] },
  ].filter(Boolean);
  for (const p of compat) {
    for (const model of p.models) {
      if (requests >= maxRequests) break;
      requests++;
      const r = await fetch(`${p.base}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${p.key}` },
        body: JSON.stringify({ model, temperature: 0.3, max_tokens: 4096,
          messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
          ...(json && p.name === "groq" ? { response_format: { type: "json_object" } } : {}) }),
      }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
      if (!r.ok) { errors.push(`${p.name} ${model}: ${r.status} ${errMsg(await r.text())}`); continue; }
      const text = clean((await r.json()).choices?.[0]?.message?.content);
      if (text) return { text, provider: `${p.name}:${model}`, requests };
    }
  }
  return { text: null, requests, error: errors.join(" | ") || "אין ספק AI זמין" };
}

function parseJSON(text) {
  if (!text) return null;
  const t = text.replace(/^```(?:json)?|```$/gm, "").trim();
  try { return JSON.parse(t); } catch (e) { /* try to cut out the object */ }
  const m = t.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch (e) { return null; }
}

/* ------------------------------------------------------------------ indicators (JS port of the scanner's) */
const sma = (a, n) => a.map((_, i) => (i + 1 < n ? null : a.slice(i + 1 - n, i + 1).reduce((s, v) => s + v, 0) / n));
function ema(a, n) { const k = 2 / (n + 1); let e = a[0]; return a.map((v, i) => (e = i ? v * k + e * (1 - k) : v)); }
function stdev(a, n) {
  return a.map((_, i) => {
    if (i + 1 < n) return null;
    const w = a.slice(i + 1 - n, i + 1), m = w.reduce((s, v) => s + v, 0) / n;
    return Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / n);
  });
}
function rsi(c, n = 14) {
  const out = Array(c.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; if (i === n) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); continue; }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
const r4 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 10000) / 10000);

export function buildSnapshot(ticker, bars, meta) {
  const c = bars.c, h = bars.h, l = bars.l, v = bars.v, n = c.length;
  const sma20 = sma(c, 20), sma50 = sma(c, 50), sma200 = sma(c, 200), sd = stdev(c, 20);
  const up = sma20.map((m, i) => (m == null ? null : m + 2 * sd[i])), lo = sma20.map((m, i) => (m == null ? null : m - 2 * sd[i]));
  const e12 = ema(c, 12), e26 = ema(c, 26), macd = e12.map((x, i) => x - e26[i]), sig = ema(macd, 9);
  const rs = rsi(c);
  const tr = c.map((_, i) => (i ? Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])) : h[i] - l[i]));
  const atr = sma(tr, 14);
  const bw = up.map((u, i) => (u == null ? null : (u - lo[i]) / sma20[i]));
  const recentBw = bw.slice(-126).filter((x) => x != null);
  const bwPctl = recentBw.length > 40 ? (recentBw.filter((x) => x <= bw[n - 1]).length / recentBw.length) * 100 : null;
  const vol20 = sma(v, 20);
  const L = n - 1, P = n - 2, price = c[L];
  const pctb = up[L] != null ? (price - lo[L]) / (up[L] - lo[L] || 1) : null;
  const year = c.slice(-252);
  const ind = {
    price, prev_close: c[P], change_pct: (price / c[P] - 1) * 100,
    change_5d_pct: n > 6 ? (price / c[n - 6] - 1) * 100 : null, change_1m_pct: n > 22 ? (price / c[n - 22] - 1) * 100 : null,
    high_52w: Math.max(...h.slice(-252)), low_52w: Math.min(...l.slice(-252)),
    sma20: sma20[L], sma50: sma50[L], sma200: sma200[L], macd: macd[L], macd_sig: sig[L], macd_hist: macd[L] - sig[L],
    bb_up: up[L], bb_mid: sma20[L], bb_lo: lo[L], bb_pctb: pctb, bb_bw: bw[L], bb_bw_pctl: bwPctl, rsi: rs[L], atr: atr[L],
    vol_ratio: vol20[L] ? v[L] / vol20[L] : null,
  };
  ind.dist_52w_high_pct = (price / Math.max(...year) - 1) * 100;

  const S = (code, cat, dir, strength, title, desc) => ({ code, cat, dir, strength, title, desc });
  const signals = [];
  if (bwPctl != null && bwPctl <= 10) signals.push(S("bb_squeeze", "bollinger", 0, 0.6, "סחיטת בולינגר", `רוחב הרצועות בשפל של ${bwPctl.toFixed(0)}% מחצי השנה – צפויה תנועה חדה.`));
  if (c[P] < lo[P] && price > lo[L]) signals.push(S("bb_reentry_up", "bollinger", 1, 0.75, "חזרה לתוך הרצועות מלמטה", "איתות היפוך קלאסי לקנייה."));
  if (c[P] > up[P] && price < up[L]) signals.push(S("bb_reentry_down", "bollinger", -1, 0.7, "חזרה לתוך הרצועות מלמעלה", "סימן להתשת קונים."));
  if (price > up[L] && ind.vol_ratio >= 1.5) signals.push(S("bb_breakout", "bollinger", 1, 0.7, "פריצת רצועה עליונה בנפח", `נפח ×${ind.vol_ratio.toFixed(1)}.`));
  if (rs[P] < 30 && rs[L] >= 30) signals.push(S("rsi_up30", "momentum", 1, 0.6, "RSI חוצה 30 כלפי מעלה", "יציאה ממכירת יתר."));
  if (rs[P] > 70 && rs[L] <= 70) signals.push(S("rsi_down70", "momentum", -1, 0.55, "RSI חוצה 70 כלפי מטה", "המומנטום נחלש."));
  if (macd[P] < sig[P] && macd[L] > sig[L]) signals.push(S("macd_up", "momentum", 1, 0.5, "חציית MACD חיובית", ""));
  if (macd[P] > sig[P] && macd[L] < sig[L]) signals.push(S("macd_down", "momentum", -1, 0.5, "חציית MACD שלילית", ""));
  if (sma200[L] != null) {
    if (sma50[n - 4] < sma200[n - 4] && sma50[L] > sma200[L]) signals.push(S("golden_cross", "trend", 1, 0.8, "צלב זהב (50/200)", ""));
    if (sma50[n - 4] > sma200[n - 4] && sma50[L] < sma200[L]) signals.push(S("death_cross", "trend", -1, 0.8, "צלב מוות (50/200)", ""));
    if (price > sma50[L] && sma50[L] > sma200[L]) signals.push(S("uptrend", "trend", 1, 0.35, "מגמת עלייה", "מחיר מעל ממוצע 50 שמעל 200."));
    else if (price < sma50[L] && sma50[L] < sma200[L]) signals.push(S("downtrend", "trend", -1, 0.35, "מגמת ירידה", "מחיר מתחת לממוצע 50 שמתחת ל‑200."));
  }
  let raw = signals.reduce((s, g) => s + g.dir * g.strength, 0);
  raw += sma200[L] ? (price > sma200[L] ? 0.25 : -0.25) : 0;
  raw += ((rs[L] ?? 50) - 50) / 200;
  const score = Math.round(1000 * Math.tanh(raw / 2.2)) / 10;

  const k = Math.max(0, n - 160);
  const sl = (a) => a.slice(k).map(r4);
  const chart = { t: bars.t.slice(k), o: sl(bars.o), h: sl(h), l: sl(l), c: sl(c), v: sl(v), bb_up: sl(up), bb_mid: sl(sma20), bb_lo: sl(lo),
    sma50: sl(sma50), sma200: sl(sma200), rsi: sl(rs), macd: sl(macd), macd_sig: sl(sig) };
  const top = [...signals].sort((a, b) => b.strength - a.strength)[0];
  return { ticker, name: meta.name || ticker, currency: meta.currency, ind, signals, score, tech_score: score, chart,
    top_signal: top ? top.title : "", live: true, is_holding: false, holding: null, news_items: [], alerts: [], fundamentals: {}, congress: [] };
}

export async function liveLookup(env, ticker) {
  const cacheKey = `look:${ticker}`;
  const cached = await env.RADAR.get(cacheKey, "json");
  if (cached && Date.now() / 1000 - cached.updated < 1800) return cached;
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d`, {
    headers: { "User-Agent": "Mozilla/5.0 (TradingRadar)" },
  });
  if (!r.ok) return null;
  const res = (await r.json()).chart?.result?.[0];
  const q = res?.indicators?.quote?.[0];
  if (!res?.timestamp || !q) return null;
  const div = res.meta?.currency === "ILA" ? 100 : 1;
  const bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
  res.timestamp.forEach((ts, i) => {
    if (q.close[i] == null) return;
    bars.t.push(new Date(ts * 1000).toISOString().slice(0, 10));
    bars.o.push((q.open[i] ?? q.close[i]) / div); bars.h.push((q.high[i] ?? q.close[i]) / div);
    bars.l.push((q.low[i] ?? q.close[i]) / div); bars.c.push(q.close[i] / div); bars.v.push(q.volume[i] || 0);
  });
  if (bars.c.length < 60) return null;
  const snap = buildSnapshot(ticker, bars, { name: res.meta?.longName || res.meta?.shortName, currency: div === 100 || res.meta?.currency === "ILS" ? "ILS" : "USD" });
  snap.news_items = await headlines(ticker, snap.name);
  snap.updated = Date.now() / 1000;
  await env.RADAR.put(cacheKey, JSON.stringify(snap), { expirationTtl: 6 * 3600 });
  return snap;
}

async function headlines(ticker, name) {
  const he = ticker.endsWith(".TA");
  const q = encodeURIComponent(he ? `"${name || ticker.split(".")[0]}" מניה` : `${ticker.replace("^", "")} stock`);
  const url = he ? `https://news.google.com/rss/search?q=${q}&hl=iw&gl=IL&ceid=IL:he` : `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const xml = await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })).text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8);
    return items.map((m, i) => {
      const raw = (m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
      const title = raw.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      const [t, src] = title.includes(" - ") ? [title.slice(0, title.lastIndexOf(" - ")), title.slice(title.lastIndexOf(" - ") + 3)] : [title, "Google News"];
      const link = (m[1].match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
      const date = Date.parse((m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "") / 1000 || Date.now() / 1000;
      return { id: `${ticker}-${i}`, ticker, source: src, kind: "news", title: t, url: link, ts: date, sentiment: 0 };
    });
  } catch (e) {
    return [];
  }
}

/* ------------------------------------------------------------------ prompts */
const SYSTEM_REC = "אתה אנליסט שוק הון זהיר ומנוסה. אתה מקבל נתונים טכניים, חדשות ונתונים פונדמנטליים ומחזיר הערכה תמציתית בעברית. אל תמציא נתונים שלא קיבלת. החזר JSON תקין בלבד.";
const SYSTEM_QA = "אתה אנליסט שוק הון מנוסה שעונה למשקיע פרטי בעברית. ענה רק על בסיס הנתונים שקיבלת על המניה ועל התיק שלו; אם חסר נתון – אמור זאת ואל תמציא. היה ענייני וקצר (עד 170 מילים), תן מספרים מדויקים כשיש (מחיר, סטופ, יעד, RSI, רצועות בולינגר), וציין סיכונים מרכזיים. כשמבקשים המלצה – תן עמדה ברורה (קנייה/הגדלה/החזקה/מעקב/מימוש/מכירה/להימנע) עם הנימוק. אל תוסיף הסתייגות משפטית ארוכה.";

function fmt(v, d = 2) { return v == null || !isFinite(v) ? "n/a" : Number(v).toFixed(d); }

export function stockContext(s, extra = {}) {
  const i = s.ind || {}, a = s.analysis || {}, h = s.holding, f = s.fundamentals || {};
  const lines = [
    `מניה: ${s.ticker} (${s.name || ""}) · מטבע ${s.currency || ""}`,
    `מחיר ${fmt(i.price)} | יומי ${fmt(i.change_pct)}% | 5 ימים ${fmt(i.change_5d_pct)}% | חודש ${fmt(i.change_1m_pct)}% | מהשיא השנתי ${fmt(i.dist_52w_high_pct, 1)}%`,
    `בולינגר(20,2): עליונה ${fmt(i.bb_up)} אמצע ${fmt(i.bb_mid)} תחתונה ${fmt(i.bb_lo)} | %B ${fmt(i.bb_pctb)} | אחוזון רוחב ${fmt(i.bb_bw_pctl, 0)}`,
    `RSI ${fmt(i.rsi, 0)} | MACD hist ${fmt(i.macd_hist, 3)} | SMA50 ${fmt(i.sma50)} | SMA200 ${fmt(i.sma200)} | ATR ${fmt(i.atr)} | נפח יחסי ${fmt(i.vol_ratio)}`,
    `ציון משוקלל ${fmt(s.score, 0)} (‎-100..100) · איתותים: ${(s.signals || []).map((g) => g.title).join("; ") || "אין"}`,
  ];
  if (a.action) lines.push(`ניתוח אחרון: ${a.action} (${a.confidence || 0}%) – ${a.headline || ""}`);
  if (h) lines.push(`בתיק של המשתמש: ${h.shares} יח' במחיר ממוצע ${h.avg_price} | סטופ ${h.stop_loss ?? "אין"} | יעד ${h.take_profit ?? "אין"} | רווח/הפסד ${fmt(s.pnl_pct, 1)}%`);
  else lines.push("המשתמש לא מחזיק במניה.");
  if (s.sizing) lines.push(`תוכנית מוצעת: כניסה ${fmt(s.sizing.entry)} סטופ ${fmt(s.sizing.stop)} יעד ${fmt(s.sizing.target)} (${s.sizing.shares ?? "?"} יח')`);
  const fk = Object.entries(f).filter(([k, v]) => v != null && k !== "name").map(([k, v]) => `${k}=${typeof v === "number" ? fmt(v) : v}`);
  if (fk.length) lines.push("פונדמנטלי: " + fk.join(", "));
  if (s.social?.messages) lines.push(`StockTwits: שוריים ${s.social.bull} / דוביים ${s.social.bear}`);
  if (s.congress?.length) lines.push("עסקאות קונגרס: " + s.congress.slice(0, 3).map((c) => `${c.member} ${c.type} ${c.amount} (${c.date})`).join("; "));
  const news = (s.news_items || []).slice(0, 8);
  if (news.length) lines.push("כותרות אחרונות:\n" + news.map((n) => `- [${n.source}] ${n.title}`).join("\n"));
  if (extra.portfolio) lines.push(`תיק המשתמש: שווי ${fmt(extra.portfolio.total, 0)} ${extra.portfolio.base} · מזומן ${fmt(extra.portfolio.cash, 0)}`);
  return lines.join("\n");
}

const ALLOWED = ["BUY", "ADD", "HOLD", "WATCH", "AVOID", "TRIM", "SELL"];

export async function recommend(env, keys, snap, extra = {}) {
  const held = !!snap.holding;
  const prompt = `${stockContext(snap, extra)}\n\n${held ? "המניה בתיק – בחר ADD/HOLD/TRIM/SELL." : "המניה לא בתיק – בחר BUY (לקנות עכשיו), WATCH (לעקוב ולחכות לכניסה) או AVOID (להימנע)."}
החזר JSON: {"action":"...","confidence":0-100,"headline":"משפט אחד","summary":"2-3 משפטים","bull":["..."],"bear":["..."],"entry":מספר או null,"stop":מספר או null,"target":מספר או null,"horizon":"ימים|שבועות|חודשים"}`;
  const r = await llmCall(env, keys, { system: SYSTEM_REC, prompt, json: true });
  const o = parseJSON(r.text);
  if (!o) return { error: r.error || "התשובה לא הייתה תקינה", requests: r.requests };
  let act = String(o.action || "").toUpperCase();
  if (!ALLOWED.includes(act)) act = held ? "HOLD" : "WATCH";
  if (!held && ["HOLD", "ADD", "TRIM", "SELL"].includes(act)) act = { ADD: "BUY", SELL: "AVOID", TRIM: "AVOID" }[act] || "WATCH";
  if (held && ["BUY", "WATCH", "AVOID"].includes(act)) act = { BUY: "ADD", AVOID: "TRIM" }[act] || "HOLD";
  const num = (v) => (v == null || v === "" || isNaN(+v) ? null : +v);
  return {
    analysis: { action: act, confidence: Math.max(0, Math.min(100, +o.confidence || 50)), headline: clean(o.headline), summary: clean(o.summary),
      bull: (o.bull || []).map(String).slice(0, 5), bear: (o.bear || []).map(String).slice(0, 5),
      entry: num(o.entry), stop: num(o.stop), target: num(o.target), horizon: clean(o.horizon), provider: r.provider },
    requests: r.requests,
  };
}

export async function ask(env, keys, snap, question, history = [], extra = {}) {
  const turns = (Array.isArray(history) ? history : []).slice(-6)
    .map((m) => `${m.role === "assistant" ? "אנליסט" : "משקיע"}: ${clean(m.text).slice(0, 600)}`).join("\n");
  const prompt = `נתוני המניה (עדכניים לסריקה האחרונה):\n${stockContext(snap, extra)}\n\n${turns ? `השיחה עד כה:\n${turns}\n\n` : ""}שאלת המשקיע: ${clean(question).slice(0, 500)}`;
  const r = await llmCall(env, keys, { system: SYSTEM_QA, prompt });
  return { answer: r.text, provider: r.provider, requests: r.requests, error: r.text ? null : r.error };
}
