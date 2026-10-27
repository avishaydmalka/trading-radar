/**
 * Trading Radar – Cloudflare Worker (multi-user).
 *
 * - Serves the dashboard (static assets).
 * - Login: each person picks their tab and enters their own password → signed session cookie.
 * - Answers the dashboard API from KV, per user (written by the GitHub Actions scanner).
 * - Saves portfolio edits per user, triggers scans in GitHub, runs the Telegram bot (webhook).
 *
 * KV keys: users, config:<uid>, dashboard:<uid>, stocks:<uid>, push_subs:<uid>, alerts_read_ts:<uid>,
 *          backtests (shared), vapid, public_url, tg_hook, session_key, fail:<uid>
 */

const ACTION_HE = { BUY: "קנייה", ADD: "הגדלה", HOLD: "החזקה", WATCH: "מעקב", TRIM: "מימוש חלקי", SELL: "מכירה" };
const LEVEL_EMOJI = { critical: "🔴", warning: "🟡", opportunity: "🟢", info: "🔵" };
const STRATEGIES = {
  bb_reversion: "בולינגר – חזרה לממוצע",
  bb_breakout: "בולינגר – פריצה מסחיטה",
  sma_cross: "צלב ממוצעים 50/200",
  rsi_reversion: "RSI 30/70",
};
const DEFAULT_RISK = { cash: 10000, risk_per_trade_pct: 1, max_position_pct: 15, max_basket_pct: 40, default_stop_pct: 8, atr_stop_mult: 2, reward_risk: 2 };
const PUBLIC_API = ["/api/health", "/api/users/public", "/api/login", "/api/logout"];
const SESSION_DAYS = 30;
const PBKDF2_ITER = 10000;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let path = url.pathname;
    if (path.startsWith("/static/")) path = path.slice(7); // HTML references /static/…
    try {
      if (path.startsWith("/telegram/")) return await telegramWebhook(request, env, ctx, path.split("/")[2]);
      if (path.startsWith("/api/")) {
        if (PUBLIC_API.includes(path)) return await publicApi(request, env, url, path);
        const user = await sessionUser(request, env);
        if (!user) return json({ error: "login required" }, 401);
        return await api(request, env, ctx, url, path, user);
      }
    } catch (err) {
      return json({ error: String((err && err.message) || err) }, 500);
    }
    const assetUrl = new URL(request.url);
    assetUrl.pathname = path;
    return env.ASSETS.fetch(new Request(assetUrl, request));
  },
};

/* ------------------------------------------------------------------ KV helpers */
const kvJSON = async (env, key, fallback = null) => (await env.RADAR.get(key, "json")) ?? fallback;
const putJSON = (env, key, v) => env.RADAR.put(key, JSON.stringify(v));

/** per-user key, with the pre-multi-user key as fallback for the admin */
async function userGet(env, base, uid, type = "text") {
  let v = await env.RADAR.get(`${base}:${uid}`, type);
  if (v == null && uid === "admin") v = await env.RADAR.get(base, type);
  return v;
}

async function getUsers(env) {
  const users = await kvJSON(env, "users");
  return users && users.length ? users : [{ id: "admin", name: "מנהל", is_admin: true, color: 0 }];
}

async function getConfig(env, uid) {
  const cfg = (await userGet(env, "config", uid, "json")) || {};
  return { holdings: cfg.holdings || [], watchlist: cfg.watchlist || [], risk: { ...DEFAULT_RISK, ...(cfg.risk || {}) }, feeds: cfg.feeds || {} };
}

const norm = (t) => String(t || "").trim().toUpperCase();
const num = (v) => (v === "" || v == null || isNaN(+v) ? null : +v);
const clean = (s) => String(s ?? "").trim();

/* ------------------------------------------------------------------ crypto */
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

function safeEq(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

async function hashPassword(password, saltB64) {
  const salt = saltB64 ? fromB64u(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITER }, key, 256);
  return { salt: b64u(salt), hash: b64u(bits), iter: PBKDF2_ITER };
}

async function sessionKey(env) {
  let k = await env.RADAR.get("session_key");
  if (!k) {
    k = b64u(crypto.getRandomValues(new Uint8Array(32)));
    await env.RADAR.put("session_key", k);
  }
  return crypto.subtle.importKey("raw", fromB64u(k), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function makeSession(env, uid) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const body = `${uid}.${exp}`;
  const sig = b64u(await crypto.subtle.sign("HMAC", await sessionKey(env), enc.encode(body)));
  return `${body}.${sig}`;
}

async function sessionUser(request, env) {
  const m = (request.headers.get("cookie") || "").match(/(?:^|;\s*)radar_session=([^;]+)/);
  if (!m) return null;
  const [uid, exp, sig] = decodeURIComponent(m[1]).split(".");
  if (!uid || !exp || !sig || +exp < Date.now() / 1000) return null;
  const ok = await crypto.subtle.verify("HMAC", await sessionKey(env), fromB64u(sig), enc.encode(`${uid}.${exp}`)).catch(() => false);
  if (!ok) return null;
  const user = (await getUsers(env)).find((u) => u.id === uid);
  if (!user) return null;
  if (user.pw && user.pw.changed && +exp - SESSION_DAYS * 86400 < user.pw.changed) return null; // password changed → old sessions die
  return user;
}

const cookie = (value, maxAge) =>
  `radar_session=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/* ------------------------------------------------------------------ public API: login */
async function publicApi(request, env, url, path) {
  if (path === "/api/health") return json({ ok: true });
  if (path === "/api/users/public") {
    const users = await getUsers(env);
    return json(users.map((u) => ({ id: u.id, name: u.name, color: u.color ?? 0 })));
  }
  if (path === "/api/logout") return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
  if (path === "/api/login" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const users = await getUsers(env);
    const user = users.find((u) => u.id === body.uid);
    const password = clean(body.password);
    if (!user || !password) return json({ error: "בחר משתמש והכנס סיסמה" }, 400);

    const failKey = `fail:${user.id}`;
    const fails = await kvJSON(env, failKey, { n: 0, ts: 0 });
    if (fails.n >= 8 && Date.now() - fails.ts < 15 * 60 * 1000) {
      return json({ error: "יותר מדי ניסיונות. נסה שוב בעוד 15 דקות." }, 429);
    }
    let ok = false;
    if (user.pw && user.pw.hash) {
      const h = await hashPassword(password, user.pw.salt);
      ok = safeEq(h.hash, user.pw.hash);
    } else if (user.is_admin) {
      if (!env.DASHBOARD_PASSWORD) return json({ error: "DASHBOARD_PASSWORD לא הוגדר ב-GitHub Secrets" }, 500);
      ok = safeEq(password, clean(env.DASHBOARD_PASSWORD));
    }
    if (!ok) {
      await putJSON(env, failKey, { n: (Date.now() - fails.ts > 15 * 60 * 1000 ? 0 : fails.n) + 1, ts: Date.now() });
      return json({ error: "סיסמה שגויה" }, 401);
    }
    if (fails.n) await env.RADAR.delete(failKey);
    return json({ ok: true, user: publicUser(user) }, 200, { "set-cookie": cookie(await makeSession(env, user.id), SESSION_DAYS * 86400) });
  }
  return json({ error: "not found" }, 404);
}

const publicUser = (u) => ({ id: u.id, name: u.name, is_admin: !!u.is_admin, color: u.color ?? 0, telegram_chat_id: u.telegram_chat_id || "" });

/* ------------------------------------------------------------------ API (logged in) */
async function api(request, env, ctx, url, path, user) {
  const m = request.method;
  const uid = user.id;
  const body = m === "GET" ? {} : await request.json().catch(() => ({}));

  if (path === "/api/dashboard") {
    ctx.waitUntil(housekeeping(env, url));
    return json(await dashboard(env, user));
  }

  // ---- account
  if (path === "/api/me") {
    if (m === "PUT") {
      const users = await getUsers(env);
      const me = users.find((u) => u.id === uid);
      if (body.name != null && clean(body.name)) me.name = clean(body.name).slice(0, 30);
      if (body.telegram_chat_id != null) me.telegram_chat_id = clean(body.telegram_chat_id).replace(/[^\d-]/g, "");
      if (body.new_password != null) {
        if (clean(body.new_password).length < 4) return json({ error: "סיסמה של לפחות 4 תווים" }, 400);
        const current = clean(body.current_password);
        const okCurrent = me.pw?.hash ? safeEq((await hashPassword(current, me.pw.salt)).hash, me.pw.hash)
          : me.is_admin ? safeEq(current, clean(env.DASHBOARD_PASSWORD)) : false;
        if (!okCurrent) return json({ error: "הסיסמה הנוכחית שגויה" }, 400);
        me.pw = { ...(await hashPassword(clean(body.new_password))), changed: Math.floor(Date.now() / 1000) };
      }
      await putJSON(env, "users", users);
      const headers = body.new_password != null ? { "set-cookie": cookie(await makeSession(env, uid), SESSION_DAYS * 86400) } : {};
      return json(publicUser(me), 200, headers);
    }
    return json(publicUser(user));
  }

  // ---- personal AI keys (stored server-side only; the browser only ever sees the last 4 characters)
  if (path === "/api/me/llm") {
    const key = `llm_keys:${uid}`;
    const keys = await kvJSON(env, key, {});
    if (m === "PUT") {
      const results = {};
      for (const p of ["gemini", "groq", "openrouter"]) {
        if (body[p] === undefined) continue;
        const v = clean(body[p]);
        if (!v) { delete keys[p]; results[p] = "removed"; continue; }
        const check = await validateKey(p, v);
        if (!check.ok) return json({ error: `מפתח ${p} לא עבד: ${check.error}` }, 400);
        keys[p] = v;
        results[p] = "ok";
      }
      await putJSON(env, key, keys);
      return json({ ok: true, results, keys: maskKeys(keys) });
    }
    const usage = await kvJSON(env, "llm_usage", {});
    return json({ keys: maskKeys(keys), shared_used_today: usage.users?.[uid] || 0 });
  }
  if (path === "/api/llm/usage") {
    if (!user.is_admin) return json({ error: "admin only" }, 403);
    return json(await kvJSON(env, "llm_usage", {}));
  }

  // ---- user management (admin)
  if (path.startsWith("/api/users")) {
    if (!user.is_admin) return json({ error: "רק המנהל יכול לנהל משתמשים" }, 403);
    const users = await getUsers(env);
    if (path === "/api/users" && m === "GET") {
      return json(users.map((u) => ({ ...publicUser(u), has_password: !!(u.pw && u.pw.hash) || !!u.is_admin })));
    }
    if (path === "/api/users" && m === "POST") {
      const name = clean(body.name).slice(0, 30);
      const password = clean(body.password);
      if (!name || password.length < 4) return json({ error: "שם וסיסמה של לפחות 4 תווים" }, 400);
      if (users.length >= 8) return json({ error: "מקסימום 8 משתמשים בגרסה החינמית" }, 400);
      if (users.some((u) => u.name === name)) return json({ error: "כבר יש משתמש בשם הזה" }, 400);
      const id = "u" + b64u(crypto.getRandomValues(new Uint8Array(4))).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
      const used = new Set(users.map((u) => u.color ?? 0));
      const color = [0, 1, 2, 3, 4, 5, 6, 7].find((c) => !used.has(c)) ?? users.length % 8;
      users.push({ id, name, is_admin: false, color, telegram_chat_id: "", pw: { ...(await hashPassword(password)), changed: 0 } });
      await putJSON(env, "users", users);
      await putJSON(env, `config:${id}`, { holdings: [], watchlist: [], risk: { ...DEFAULT_RISK }, feeds: {} });
      return json({ id, name });
    }
    const id = path.split("/")[3];
    const target = users.find((u) => u.id === id);
    if (!target) return json({ error: "משתמש לא נמצא" }, 404);
    if (m === "PUT") {
      if (body.name && clean(body.name)) target.name = clean(body.name).slice(0, 30);
      if (body.password) {
        if (target.is_admin && !target.pw) return json({ error: "את סיסמת המנהל משנים ב-GitHub Secrets או ב'חשבון'" }, 400);
        if (clean(body.password).length < 4) return json({ error: "סיסמה של לפחות 4 תווים" }, 400);
        target.pw = { ...(await hashPassword(clean(body.password))), changed: Math.floor(Date.now() / 1000) };
      }
      await putJSON(env, "users", users);
      return json(publicUser(target));
    }
    if (m === "DELETE") {
      if (target.is_admin) return json({ error: "אי אפשר למחוק את המנהל" }, 400);
      await putJSON(env, "users", users.filter((u) => u.id !== id));
      await Promise.all(["config", "dashboard", "stocks", "db", "push_subs", "alerts_read_ts", "llm_keys"].map((k) => env.RADAR.delete(`${k}:${id}`)));
      return json({ ok: true });
    }
  }

  // ---- market data for this user
  if (path.startsWith("/api/stock/")) {
    const t = norm(decodeURIComponent(path.split("/")[3]));
    const raw = await sliceBundle(await userGet(env, "stocks", uid), t);
    if (!raw) return json({ error: "not tracked" }, 404);
    return new Response(raw, { headers: { "content-type": "application/json; charset=utf-8" } });
  }
  if (path === "/api/backtest") {
    const t = norm(url.searchParams.get("ticker"));
    const s = url.searchParams.get("strategy") || "bb_reversion";
    const raw = await sliceBundle(await env.RADAR.get("backtests"), t);
    if (!raw) return json({ error: "הבדיקה תהיה זמינה אחרי הסריקה היומית" }, 400);
    const all = JSON.parse(raw);
    if (!all[s]) return json({ error: "אין מספיק היסטוריה למניה הזו" }, 400);
    return json({ ...all[s], ticker: t, note: "תקופה: 3 שנים (מחושב פעם ביום)" });
  }
  if (path === "/api/strategies") return json(STRATEGIES);

  // ---- portfolio edits (saved to KV, applied on the next scan)
  const saveCfg = async (cfg, rescan = true) => {
    await putJSON(env, `config:${uid}`, cfg);
    if (rescan) ctx.waitUntil(dispatchScan(env, uid, false));
  };
  if (path === "/api/holdings" && m === "POST") {
    if (!body.ticker || !body.shares || !body.avg_price) return json({ error: "חובה: סימול, כמות ומחיר ממוצע" }, 400);
    const cfg = await getConfig(env, uid);
    const id = Math.max(0, ...cfg.holdings.map((h) => +h.id || 0)) + 1;
    cfg.holdings.push(cleanHolding({ ...body, id }));
    cfg.watchlist = cfg.watchlist.filter((w) => w.ticker !== norm(body.ticker));
    await saveCfg(cfg);
    return json({ id });
  }
  if (path.startsWith("/api/holdings/")) {
    const id = +path.split("/")[3];
    const cfg = await getConfig(env, uid);
    if (m === "DELETE") cfg.holdings = cfg.holdings.filter((h) => +h.id !== id);
    else cfg.holdings = cfg.holdings.map((h) => (+h.id === id ? cleanHolding({ ...h, ...body, id }) : h));
    await saveCfg(cfg);
    return json({ ok: true });
  }
  if (path === "/api/holdings") return json((await getConfig(env, uid)).holdings);
  if (path === "/api/watchlist" && m === "POST") {
    if (!body.ticker) return json({ error: "חובה: סימול" }, 400);
    const cfg = await getConfig(env, uid);
    const t = norm(body.ticker);
    cfg.watchlist = cfg.watchlist.filter((w) => w.ticker !== t).concat([{ ticker: t, basket: body.basket || "מעקב" }]);
    await saveCfg(cfg);
    return json({ ok: true });
  }
  if (path.startsWith("/api/watchlist/") && m === "DELETE") {
    const cfg = await getConfig(env, uid);
    const t = norm(decodeURIComponent(path.split("/")[3]));
    cfg.watchlist = cfg.watchlist.filter((w) => w.ticker !== t);
    await saveCfg(cfg, false);
    return json({ ok: true });
  }
  if (path === "/api/watchlist") return json((await getConfig(env, uid)).watchlist);
  if (path === "/api/risk") {
    const cfg = await getConfig(env, uid);
    if (m === "PUT") {
      for (const [k, v] of Object.entries(body)) if (k in DEFAULT_RISK && num(v) != null) cfg.risk[k] = +v;
      await saveCfg(cfg);
    }
    return json(cfg.risk);
  }

  // ---- scans / alerts / push
  if (path === "/api/scan" && m === "POST") {
    const r = await dispatchScan(env, uid, url.searchParams.get("llm") === "1", true);
    return json(r, r.error ? 400 : 200);
  }
  if (path === "/api/alerts/read" && m === "POST") {
    await env.RADAR.put(`alerts_read_ts:${uid}`, String(Date.now() / 1000));
    return json({ ok: true });
  }
  if (path === "/api/push/key") return json({ publicKey: (await kvJSON(env, "vapid", {})).public || null });
  if (path === "/api/push/subscribe" && m === "POST") {
    if (!body.endpoint) return json({ error: "bad subscription" }, 400);
    const subs = ((await userGet(env, "push_subs", uid, "json")) || []).filter((s) => s.endpoint !== body.endpoint);
    subs.push(body);
    await putJSON(env, `push_subs:${uid}`, subs.slice(-10));
    return json({ ok: true });
  }
  if (path === "/api/notify/test" && m === "POST") {
    const chat = chatIdFor(env, user);
    if (env.TELEGRAM_BOT_TOKEN && chat) await tgSend(env, chat, `🔵 <b>בדיקת התראות</b>\nשלום ${esc(user.name)} – טלגרם מחובר ✔`);
    return json({ ok: true, telegram: !!(env.TELEGRAM_BOT_TOKEN && chat), webpush: false, note: "Push נבדק בסריקה הבאה שתמצא התראה" });
  }

  // ---- broker (Alpaca paper, admin's keys only)
  if (path === "/api/broker/account") {
    if (!env.ALPACA_API_KEY || !user.is_admin) return json({ enabled: false });
    const [a, p] = await Promise.all([alpaca(env, "/v2/account"), alpaca(env, "/v2/positions")]);
    return json({ enabled: true, account: a, positions: p });
  }
  if (path === "/api/broker/order" && m === "POST") {
    if (!env.ALPACA_API_KEY || !user.is_admin) return json({ error: "broker not configured" }, 400);
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

const maskKeys = (keys) => Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v ? `••••${String(v).slice(-4)}` : null]));

/** one cheap, free request that proves the key works (lists models / key info) */
async function validateKey(provider, key) {
  try {
    let r;
    if (provider === "gemini") r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(key)}`);
    else if (provider === "groq") r = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${key}` } });
    else if (provider === "openrouter") r = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` } });
    else return { ok: false, error: "ספק לא מוכר" };
    if (r.ok) return { ok: true };
    return { ok: false, error: r.status === 400 || r.status === 401 || r.status === 403 ? "המפתח לא תקין" : `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: "אין חיבור לספק" };
  }
}

function cleanHolding(h) {
  return {
    id: +h.id, ticker: norm(h.ticker), basket: h.basket || "כללי", shares: +h.shares, avg_price: +h.avg_price,
    stop_loss: num(h.stop_loss), take_profit: num(h.take_profit), trailing_pct: num(h.trailing_pct),
    notes: h.notes || "", opened_at: h.opened_at || new Date().toISOString().slice(0, 10),
  };
}

function sliceBundle(text, ticker) {
  if (!text) return null;
  const marker = `\n@@${ticker}\n`;
  const i = text.indexOf(marker);
  if (i < 0) return null;
  const start = i + marker.length;
  return text.slice(start, text.indexOf("\n@@", start));
}

async function dashboard(env, user) {
  const uid = user.id;
  const [d, cfg, readTs] = await Promise.all([userGet(env, "dashboard", uid, "json"), getConfig(env, uid), env.RADAR.get(`alerts_read_ts:${uid}`)]);
  const me = publicUser(user);
  const features = { broker: !!env.ALPACA_API_KEY && !!user.is_admin, telegram: !!(env.TELEGRAM_BOT_TOKEN && chatIdFor(env, user)),
    telegram_bot: !!env.TELEGRAM_BOT_TOKEN, scan_button: !!env.GH_DISPATCH_TOKEN, webpush: true, multiuser: true };
  if (!d) {
    return { mode: "cloud", empty: true, me, features, lots: cfg.holdings, watchlist: cfg.watchlist, risk: cfg.risk,
      has_portfolio: cfg.holdings.length + cfg.watchlist.length > 0, status: { scans: 0, markets: {} } };
  }
  d.me = me;
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
  d.features = { ...d.features, ...features };
  return d;
}

/* ------------------------------------------------------------------ GitHub dispatch */
async function dispatchScan(env, uid, forceLlm, manual = false) {
  if (!env.GH_DISPATCH_TOKEN || !env.GITHUB_REPO) return { error: "כפתור הסריקה לא מוגדר (GH_DISPATCH_TOKEN)", status: "disabled" };
  const key = `last_dispatch:${uid}`;
  const last = +((await env.RADAR.get(key)) || 0);
  if (Date.now() - last < (manual ? 60_000 : 120_000)) return { status: "busy" };
  await env.RADAR.put(key, String(Date.now()), { expirationTtl: 3600 });
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/scan.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "trading-radar", "X-GitHub-Api-Version": "2022-11-28" },
    body: JSON.stringify({ ref: env.GITHUB_BRANCH || "main", inputs: { force_llm: forceLlm ? "1" : "0", only_user: uid } }),
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
function chatIdFor(env, user) {
  return clean(user.telegram_chat_id) || (user.is_admin ? clean(env.TELEGRAM_CHAT_ID) : "");
}

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

async function telegramWebhook(request, env, ctx, secret) {
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

  const user = (await getUsers(env)).find((u) => chatIdFor(env, u) === chatId);
  if (cmd === "start" || !user) {
    await tgSend(env, chatId, `שלום! מספר הצ'אט שלך: <code>${chatId}</code>\n\nכדי לקבל כאן התראות על התיק שלך: היכנס לדשבורד ← ⚙️ ← <b>חשבון</b> ← הדבק את המספר בשדה טלגרם ושמור.${user ? `\n\nמחובר כ: <b>${esc(user.name)}</b>\n\n${HELP}` : ""}`);
    return new Response("ok");
  }

  let reply = HELP;
  const d = await dashboard(env, user);
  if (d.empty && cmd !== "scan") reply = "אין עדיין נתונים לתיק שלך – הוסף מניות בדשבורד והמתן לסריקה.";
  else if (cmd === "portfolio") reply = tgPortfolio(d);
  else if (cmd === "top") reply = tgTop(d);
  else if (cmd === "brief") reply = tgBrief(d);
  else if (cmd === "alerts") reply = tgAlerts(d);
  else if (cmd === "stock") reply = await tgStock(env, user, norm(arg));
  else if (cmd === "scan") {
    const r = await dispatchScan(env, user.id, false, true);
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
  return lines.length > 1 ? lines.join("\n") : "אין מניות ברשימת המעקב שלך.";
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

async function tgStock(env, user, t) {
  if (!t) return "שימוש: /stock NVDA";
  const raw = sliceBundle(await userGet(env, "stocks", user.id), t);
  if (!raw) return `${esc(t)} לא בתיק או ברשימת המעקב שלך.`;
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
