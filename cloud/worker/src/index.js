/**
 * Trading Radar – Cloudflare Worker.
 * Serves the dashboard (static assets) behind a password, answers the dashboard API
 * from KV (written by the GitHub Actions scanner), saves portfolio edits to KV,
 * triggers scans in GitHub, and runs the Telegram bot via webhook.
 */

const ACTION_HE = { BUY: "קנייה", ADD: "הגדלה", HOLD: "החזקה", WATCH: "מעקב", TRIM: "מימוש חלקי", SELL: "מכירה" };
const LEVEL_EMOJI = { critical: "🔴", warning: "🟡", opportunity: "🟢", info: "🔵" };
const STRATEGIES = {
  bb_reversion: "בולינגר – חזרה לממוצע",
  bb_breakout: "בולינגר – פריצה מסחיטה",
  sma_cross: "צלב ממוצעים 50/200",
  rsi_reversion: "RSI 30/70",
};
const OPEN_PATHS = ["/sw.js", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/api/health", "/telegram/"];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let path = url.pathname;
    // the HTML references /static/… (same files as the self-hosted version)
    if (path.startsWith("/static/")) path = path.slice(7);

    if (!OPEN_PATHS.some((p) => path === p || (p.endsWith("/") && path.startsWith(p)))) {
      const denied = checkAuth(request, env);
      if (denied) return denied;
    }
    try {
      if (path.startsWith("/telegram/")) return await telegramWebhook(request, env, path.split("/")[2]);
      if (path.startsWith("/api/")) return await api(request, env, ctx, url, path);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
    const assetUrl = new URL(request.url);
    assetUrl.pathname = path;
    return env.ASSETS.fetch(new Request(assetUrl, request));
  },
};

/* ------------------------------------------------------------------ auth */
function checkAuth(request, env) {
  if (!env.DASHBOARD_PASSWORD) return null; // not configured – open (set it!)
  const h = request.headers.get("authorization") || "";
  if (h.startsWith("Basic ")) {
    try {
      const [u, ...rest] = atob(h.slice(6)).split(":");
      if (safeEq(u, env.DASHBOARD_USER || "admin") && safeEq(rest.join(":"), env.DASHBOARD_PASSWORD)) return null;
    } catch (e) { /* fallthrough */ }
  }
  return new Response("Authentication required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Trading Radar"' } });
}

function safeEq(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/* ------------------------------------------------------------------ KV helpers */
const kvJSON = async (env, key, fallback = null) => (await env.RADAR.get(key, "json")) ?? fallback;
const putJSON = (env, key, v) => env.RADAR.put(key, JSON.stringify(v));

async function sliceBundle(env, key, ticker) {
  const text = await env.RADAR.get(key);
  if (!text) return null;
  const marker = `\n@@${ticker}\n`;
  const i = text.indexOf(marker);
  if (i < 0) return null;
  const start = i + marker.length;
  return text.slice(start, text.indexOf("\n@@", start));
}

async function getConfig(env) {
  return kvJSON(env, "config", { holdings: [], watchlist: [], risk: {}, feeds: {} });
}

const norm = (t) => String(t || "").trim().toUpperCase();
const num = (v) => (v === "" || v == null || isNaN(+v) ? null : +v);

/* ------------------------------------------------------------------ API */
async function api(request, env, ctx, url, path) {
  const m = request.method;
  const body = m === "GET" ? {} : await request.json().catch(() => ({}));

  if (path === "/api/health") return json({ ok: true });

  if (path === "/api/dashboard") {
    ctx.waitUntil(housekeeping(env, url));
    return json(await dashboard(env));
  }

  if (path.startsWith("/api/stock/")) {
    const t = norm(decodeURIComponent(path.split("/")[3]));
    const raw = await sliceBundle(env, "stocks", t);
    if (!raw) return json({ error: "not tracked" }, 404);
    return new Response(raw, { headers: { "content-type": "application/json; charset=utf-8" } });
  }

  if (path === "/api/backtest") {
    const t = norm(url.searchParams.get("ticker"));
    const s = url.searchParams.get("strategy") || "bb_reversion";
    const raw = await sliceBundle(env, "backtests", t);
    if (!raw) return json({ error: "הבדיקה תהיה זמינה אחרי הסריקה היומית" }, 400);
    const all = JSON.parse(raw);
    if (!all[s]) return json({ error: "אין מספיק היסטוריה למניה הזו" }, 400);
    return json({ ...all[s], ticker: t, note: "תקופה: 3 שנים (מחושב פעם ביום)" });
  }

  if (path === "/api/strategies") return json(STRATEGIES);

  // ---- portfolio edits (saved to KV, applied on the next scan)
  if (path === "/api/holdings" && m === "POST") {
    if (!body.ticker || !body.shares || !body.avg_price) return json({ error: "חובה: סימול, כמות ומחיר ממוצע" }, 400);
    const cfg = await getConfig(env);
    const id = Math.max(0, ...cfg.holdings.map((h) => +h.id || 0)) + 1;
    cfg.holdings.push(cleanHolding({ ...body, id }));
    cfg.watchlist = cfg.watchlist.filter((w) => w.ticker !== norm(body.ticker));
    await putJSON(env, "config", cfg);
    ctx.waitUntil(dispatchScan(env, false));
    return json({ id });
  }
  if (path.startsWith("/api/holdings/")) {
    const id = +path.split("/")[3];
    const cfg = await getConfig(env);
    if (m === "DELETE") cfg.holdings = cfg.holdings.filter((h) => +h.id !== id);
    else cfg.holdings = cfg.holdings.map((h) => (+h.id === id ? cleanHolding({ ...h, ...body, id }) : h));
    await putJSON(env, "config", cfg);
    ctx.waitUntil(dispatchScan(env, false));
    return json({ ok: true });
  }
  if (path === "/api/holdings") return json((await getConfig(env)).holdings);

  if (path === "/api/watchlist" && m === "POST") {
    if (!body.ticker) return json({ error: "חובה: סימול" }, 400);
    const cfg = await getConfig(env);
    const t = norm(body.ticker);
    cfg.watchlist = cfg.watchlist.filter((w) => w.ticker !== t).concat([{ ticker: t, basket: body.basket || "מעקב" }]);
    await putJSON(env, "config", cfg);
    ctx.waitUntil(dispatchScan(env, false));
    return json({ ok: true });
  }
  if (path.startsWith("/api/watchlist/") && m === "DELETE") {
    const cfg = await getConfig(env);
    const t = norm(decodeURIComponent(path.split("/")[3]));
    cfg.watchlist = cfg.watchlist.filter((w) => w.ticker !== t);
    await putJSON(env, "config", cfg);
    return json({ ok: true });
  }
  if (path === "/api/watchlist") return json((await getConfig(env)).watchlist);

  if (path === "/api/risk") {
    const cfg = await getConfig(env);
    if (m === "PUT") {
      for (const [k, v] of Object.entries(body)) if (num(v) != null) cfg.risk[k] = +v;
      await putJSON(env, "config", cfg);
    }
    return json(cfg.risk);
  }

  // ---- scans
  if (path === "/api/scan" && m === "POST") {
    const r = await dispatchScan(env, url.searchParams.get("llm") === "1", true);
    return json(r, r.error ? 400 : 200);
  }

  // ---- alerts / notifications
  if (path === "/api/alerts/read" && m === "POST") {
    await env.RADAR.put("alerts_read_ts", String(Date.now() / 1000));
    return json({ ok: true });
  }
  if (path === "/api/push/key") return json({ publicKey: (await kvJSON(env, "vapid", {})).public || null });
  if (path === "/api/push/subscribe" && m === "POST") {
    if (!body.endpoint) return json({ error: "bad subscription" }, 400);
    const subs = (await kvJSON(env, "push_subs", [])).filter((s) => s.endpoint !== body.endpoint);
    subs.push(body);
    await putJSON(env, "push_subs", subs.slice(-20));
    return json({ ok: true });
  }
  if (path === "/api/notify/test" && m === "POST") {
    let tg = false;
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      await tgSend(env, env.TELEGRAM_CHAT_ID, "🔵 <b>בדיקת התראות</b>\nאם אתה רואה את זה – טלגרם מחובר ✔");
      tg = true;
    }
    return json({ ok: true, telegram: tg, webpush: false, note: "Push נבדק בסריקה הבאה שתמצא התראה" });
  }

  // ---- broker (Alpaca paper)
  if (path === "/api/broker/account") {
    if (!env.ALPACA_API_KEY) return json({ enabled: false });
    const [a, p] = await Promise.all([alpaca(env, "/v2/account"), alpaca(env, "/v2/positions")]);
    return json({ enabled: true, account: a, positions: p });
  }
  if (path === "/api/broker/order" && m === "POST") {
    if (!env.ALPACA_API_KEY) return json({ error: "broker not configured" }, 400);
    if (body.confirm !== true) return json({ error: "explicit confirmation required" }, 400);
    const t = norm(body.ticker);
    if (t.endsWith(".TA")) return json({ error: "Alpaca תומך במניות ארה״ב בלבד" }, 400);
    const order = { symbol: t, qty: String(Math.floor(+body.qty)), side: body.side || "buy", type: "market", time_in_force: "day" };
    if (order.side === "buy" && body.stop && body.target) {
      Object.assign(order, { order_class: "bracket", time_in_force: "gtc",
        stop_loss: { stop_price: (+body.stop).toFixed(2) }, take_profit: { limit_price: (+body.target).toFixed(2) } });
    }
    const r = await alpaca(env, "/v2/orders", order);
    if (r.error || r.code) return json({ error: r.message || r.error }, 400);
    return json({ id: r.id, status: r.status, symbol: r.symbol, qty: r.qty, side: r.side });
  }

  if (path === "/api/stream") return json({ error: "live stream not available in cloud mode" }, 404);
  return json({ error: "not found" }, 404);
}

function cleanHolding(h) {
  return {
    id: +h.id, ticker: norm(h.ticker), basket: h.basket || "כללי", shares: +h.shares, avg_price: +h.avg_price,
    stop_loss: num(h.stop_loss), take_profit: num(h.take_profit), trailing_pct: num(h.trailing_pct),
    notes: h.notes || "", opened_at: h.opened_at || new Date().toISOString().slice(0, 10),
  };
}

async function dashboard(env) {
  const [d, cfg, readTs] = await Promise.all([kvJSON(env, "dashboard"), getConfig(env), env.RADAR.get("alerts_read_ts")]);
  if (!d) {
    return { mode: "cloud", empty: true, status: { scans: 0, markets: {} }, features: {}, portfolio: null };
  }
  // reflect edits made since the last scan
  d.lots = cfg.holdings;
  d.watchlist = cfg.watchlist;
  d.risk = { ...d.risk, ...cfg.risk };
  const scanned = new Set(d.holdings.map((h) => h.ticker));
  const held = new Set(cfg.holdings.map((h) => h.ticker));
  d.holdings = d.holdings.filter((h) => held.has(h.ticker));
  if (d.portfolio) d.portfolio.rows = d.portfolio.rows.filter((r) => held.has(r.ticker));
  for (const h of cfg.holdings) {
    if (!scanned.has(h.ticker)) { d.holdings.push({ ticker: h.ticker, name: h.ticker, pending: true, is_holding: true, basket: h.basket }); scanned.add(h.ticker); }
  }
  const watched = new Set(cfg.watchlist.map((w) => w.ticker));
  d.opportunities = d.opportunities.filter((o) => watched.has(o.ticker));
  const read = +(readTs || 0);
  d.alerts.forEach((a) => { a.read = a.ts <= read ? 1 : 0; });
  d.unread = d.alerts.filter((a) => !a.read).length;
  d.features = { ...d.features, broker: !!env.ALPACA_API_KEY, telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), scan_button: !!env.GH_DISPATCH_TOKEN };
  return d;
}

/* ------------------------------------------------------------------ GitHub dispatch */
async function dispatchScan(env, forceLlm, manual = false) {
  if (!env.GH_DISPATCH_TOKEN || !env.GITHUB_REPO) return { error: "כפתור הסריקה לא מוגדר (GH_DISPATCH_TOKEN)", status: "disabled" };
  const last = +(await env.RADAR.get("last_dispatch") || 0);
  if (Date.now() - last < (manual ? 60_000 : 120_000)) return { status: "busy" };
  await env.RADAR.put("last_dispatch", String(Date.now()));
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/scan.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "trading-radar", "X-GitHub-Api-Version": "2022-11-28" },
    body: JSON.stringify({ ref: env.GITHUB_BRANCH || "main", inputs: { force_llm: forceLlm ? "1" : "0" } }),
  });
  if (!r.ok) return { error: `GitHub ${r.status}: ${(await r.text()).slice(0, 150)}` };
  return { status: "started" };
}

/* ------------------------------------------------------------------ housekeeping (public URL + Telegram webhook) */
async function housekeeping(env, url) {
  const origin = url.origin;
  if ((await env.RADAR.get("public_url")) !== origin) await env.RADAR.put("public_url", origin);
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const hook = await kvJSON(env, "tg_hook", {});
  const want = `${origin}/telegram/`;
  if (hook.base === want && hook.secret) return;
  const secret = crypto.randomUUID().replace(/-/g, "");
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: want + secret, allowed_updates: ["message"], secret_token: secret }),
  });
  if (r.ok) {
    await putJSON(env, "tg_hook", { base: want, secret });
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands: [
        { command: "portfolio", description: "מצב התיק" }, { command: "top", description: "הזדמנויות מובילות" },
        { command: "stock", description: "ניתוח מניה: /stock NVDA" }, { command: "brief", description: "תדריך שוק" },
        { command: "alerts", description: "התראות אחרונות" }, { command: "scan", description: "סריקה עכשיו" } ] }),
    });
  }
}

/* ------------------------------------------------------------------ Telegram bot */
async function tgSend(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true }),
  });
}

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const f2 = (v, d = 2) => (v == null || isNaN(v) ? "—" : Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const sg = (v, d = 0) => (v == null ? "—" : (v > 0 ? "+" : "") + f2(v, d));

const HELP = "<b>רדאר מסחר – פקודות</b>\n/portfolio – מצב התיק\n/top – הזדמנויות מובילות\n/stock TICKER – ניתוח מניה\n/brief – תדריך שוק\n/alerts – התראות אחרונות\n/scan – סריקה עכשיו";

async function telegramWebhook(request, env, secret) {
  const hook = await kvJSON(env, "tg_hook", {});
  if (!hook.secret || secret !== hook.secret || request.headers.get("x-telegram-bot-api-secret-token") !== hook.secret) {
    return new Response("forbidden", { status: 403 });
  }
  const upd = await request.json().catch(() => ({}));
  const msg = upd.message || {};
  const chatId = String(msg.chat?.id || "");
  const text = (msg.text || "").trim();
  if (!text.startsWith("/")) return new Response("ok");
  const [cmdRaw, ...rest] = text.slice(1).split(" ");
  const cmd = cmdRaw.split("@")[0].toLowerCase();
  const arg = rest.join(" ").trim();

  if (cmd === "start" || !env.TELEGRAM_CHAT_ID) {
    await tgSend(env, chatId, `שלום! ה-chat id שלך: <code>${chatId}</code>\nהכנס אותו כ-Secret בשם TELEGRAM_CHAT_ID ב-GitHub והרץ שוב את ה-Deploy.\n\n${HELP}`);
    return new Response("ok");
  }
  if (chatId !== String(env.TELEGRAM_CHAT_ID)) return new Response("ok"); // strangers are ignored

  let reply = HELP;
  const d = await dashboard(env);
  if (!d.portfolio && cmd !== "scan") reply = "אין עדיין נתונים – הסריקה הראשונה טרם הסתיימה.";
  else if (cmd === "portfolio") reply = tgPortfolio(d);
  else if (cmd === "top") reply = tgTop(d);
  else if (cmd === "brief") reply = tgBrief(d);
  else if (cmd === "alerts") reply = tgAlerts(d);
  else if (cmd === "stock") reply = await tgStock(env, norm(arg));
  else if (cmd === "scan") {
    const r = await dispatchScan(env, false, true);
    reply = r.error ? `⚠️ ${esc(r.error)}` : r.status === "busy" ? "סריקה כבר התחילה לפני רגע." : "🔄 סריקה התחילה (כ-2 דקות). התראות יישלחו אם יימצא משהו.";
  }
  await tgSend(env, chatId, reply);
  return new Response("ok");
}

function tgPortfolio(d) {
  const p = d.portfolio, s = p.base === "ILS" ? "₪" : "$";
  const snaps = Object.fromEntries(d.holdings.map((h) => [h.ticker, h]));
  const lines = [`💼 <b>שווי תיק</b> ${s}${f2(p.total, 0)}`, `יומי: ${sg(p.day_pnl)} (${sg(p.day_pnl_pct, 2)}%) | כולל: ${sg(p.pnl)} (${sg(p.total_pnl_pct, 1)}%)`, ""];
  for (const r of [...p.rows].sort((a, b) => b.value - a.value)) {
    const h = snaps[r.ticker] || {};
    const dot = (h.score || 0) > 20 ? "🟢" : (h.score || 0) < -20 ? "🔴" : "⚪";
    lines.push(`${dot} <b>${esc(r.ticker)}</b> ${sg(r.pnl_pct, 1)}% · ${ACTION_HE[h.action] || ""} (${sg(h.score)})`);
  }
  for (const w of (p.warnings || []).slice(0, 4)) lines.push(`⚠️ ${esc(w.text)}`);
  lines.push("", `<i>עודכן ${ageText(d.generated)}</i>`);
  return lines.join("\n");
}

function tgTop(d) {
  const lines = ["🚀 <b>הזדמנויות מובילות</b>"];
  for (const o of [...d.opportunities].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 8)) {
    const z = o.sizing || {};
    lines.push(`<b>${esc(o.ticker)}</b> ${sg(o.score)} · ${esc(o.top_signal || "")}\n   כניסה ${f2(z.entry)} סטופ ${f2(z.stop)} יעד ${f2(z.target)}`);
  }
  return lines.join("\n");
}

function tgBrief(d) {
  const b = d.brief;
  if (!b) return "אין עדיין תדריך.";
  const lines = [`🧭 <b>${esc(b.title)}</b> (מצב רוח ${sg(b.mood)})`, esc(b.summary)];
  if (b.focus?.length) lines.push("🎯 " + b.focus.slice(0, 4).map(esc).join(" | "));
  if (b.risks?.length) lines.push("⚠️ " + b.risks.slice(0, 3).map(esc).join(" | "));
  return lines.join("\n");
}

function tgAlerts(d) {
  if (!d.alerts.length) return "אין התראות.";
  return d.alerts.slice(0, 8).map((a) => {
    const t = new Date(a.ts * 1000).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    return `${LEVEL_EMOJI[a.level] || "•"} ${t} <b>${esc(a.ticker || "")}</b> ${esc(a.title)}`;
  }).join("\n");
}

async function tgStock(env, t) {
  if (!t) return "שימוש: /stock NVDA";
  const raw = await sliceBundle(env, "stocks", t);
  if (!raw) return `${esc(t)} לא במעקב. הוסף אותה לרשימת המעקב בדשבורד.`;
  const s = JSON.parse(raw), a = s.analysis || {}, i = s.ind || {};
  const lines = [`📈 <b>${esc(t)}</b> ${esc(s.name || "")}`,
    `מחיר ${f2(i.price)} (${sg(i.change_pct, 2)}%) · RSI ${f2(i.rsi, 0)} · %B ${f2(i.bb_pctb)}`,
    `ציון <b>${sg(s.score)}</b> · ${ACTION_HE[s.action] || ""} (${a.confidence || 0}%)`,
    `<i>${esc(a.headline || "")}</i>`, esc(a.summary || "")];
  if (a.bull?.length) lines.push("✅ " + a.bull.slice(0, 3).map(esc).join(" | "));
  if (a.bear?.length) lines.push("⚠️ " + a.bear.slice(0, 3).map(esc).join(" | "));
  return lines.join("\n");
}

function ageText(ts) {
  if (!ts) return "";
  const m = Math.round((Date.now() / 1000 - ts) / 60);
  return m < 60 ? `לפני ${m} דק׳` : `לפני ${Math.round(m / 60)} שע׳`;
}

/* ------------------------------------------------------------------ Alpaca */
async function alpaca(env, path, body) {
  const r = await fetch((env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets") + path, {
    method: body ? "POST" : "GET",
    headers: { "APCA-API-KEY-ID": env.ALPACA_API_KEY, "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json().catch(() => ({ error: `HTTP ${r.status}` }));
}
