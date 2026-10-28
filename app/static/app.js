/* Trading Radar – dashboard front-end (vanilla JS, no build step). */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const STATIC = window.__SNAPSHOT__ || null; // static demo mode (no server)
const state = { chat: {}, stock: null, d: null, basket: "all", alertFilter: "all", newsFilter: "all", charts: {}, es: null };

const ACTION_HE = { BUY: "קנייה", ADD: "הגדלה", HOLD: "החזקה", WATCH: "מעקב", AVOID: "להימנע", TRIM: "מימוש חלקי", SELL: "מכירה" };
const LEVEL = {
  critical: { ico: "🛑", he: "מכירה/סטופ" }, warning: { ico: "⚠️", he: "אזהרה" },
  opportunity: { ico: "🚀", he: "הזדמנות" }, info: { ico: "ℹ️", he: "מידע" },
};
const SERIES = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"];
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/* ------------------------------------------------------------------ API */
async function api(path, opts = {}) {
  if (STATIC) {
    const key = path.split("?")[0];
    if (opts.method && opts.method !== "GET") { toast({ level: "info", title: "מצב הדגמה", body: "בגרסת ההדגמה אין שרת – הפעולה לא נשמרה." }); return {}; }
    if (key.startsWith("/api/backtest")) { const q = new URLSearchParams(path.split("?")[1]); return STATIC.backtest?.[q.get("ticker")]?.[q.get("strategy")] || { error: "בהדגמה זמינה בדיקה של 3 שנים בלבד" }; }
    return STATIC[key] ?? {};
  }
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
  if (res.status === 401 && path !== "/api/login") { showLogin(); data.__auth = false; }
  return data;
}

/* ------------------------------------------------------------------ format */
const nf = (v, d = 2) => v == null || isNaN(v) ? "—" : Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const sym = (ccy) => ccy === "ILS" ? "₪" : "$";
const money = (v, ccy = "USD", d = 0) => v == null ? "—" : (v < 0 ? "-" : "") + sym(ccy) + nf(Math.abs(v), d);
const pct = (v, d = 2) => v == null || isNaN(v) ? "—" : (v > 0 ? "+" : "") + nf(v, d) + "%";
const signed = (v, d = 0) => v == null ? "—" : (v > 0 ? "+" : "") + nf(v, d);
const cls = (v) => v > 0 ? "up" : v < 0 ? "down" : "";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function ago(ts) {
  if (!ts) return "";
  const m = Math.round((Date.now() / 1000 - ts) / 60);
  if (m < 1) return "עכשיו";
  if (m < 60) return `לפני ${m} ד׳`;
  const h = Math.round(m / 60);
  if (h < 24) return `לפני ${h} ש׳`;
  return `לפני ${Math.round(h / 24)} ימים`;
}
function scoreColor(s) {
  if (s == null) return css("--neutral");
  if (s >= 15) return css("--bull");
  if (s <= -15) return css("--bear");
  return css("--warn");
}
function divergingColor(v, max = 3) { // v = % change → red / gray / green
  const t = Math.max(-1, Math.min(1, (v || 0) / max));
  const g = [34, 197, 94], r = [240, 82, 82], n = [60, 72, 96];
  const c = t >= 0 ? g : r, a = Math.abs(t);
  return `rgb(${n.map((x, i) => Math.round(x + (c[i] - x) * a)).join(",")})`;
}
function sparkPath(vals, w, h, pad = 2) {
  const v = (vals || []).filter((x) => x != null);
  if (v.length < 2) return "";
  const mn = Math.min(...v), mx = Math.max(...v), rng = mx - mn || 1;
  return v.map((y, i) => `${i ? "L" : "M"}${(pad + (i / (v.length - 1)) * (w - 2 * pad)).toFixed(1)},${(h - pad - ((y - mn) / rng) * (h - 2 * pad)).toFixed(1)}`).join(" ");
}
function spark(vals, w = 120, h = 30) {
  const v = (vals || []).filter((x) => x != null);
  const col = v.length > 1 && v[v.length - 1] >= v[0] ? css("--bull") : css("--bear");
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="h-spark"><path d="${sparkPath(v, w, h)}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
}

/* ------------------------------------------------------------------ load + render */
function showSections(on) {
  $$("main > section").forEach((sec, i) => { if (i > 0) sec.hidden = !on; });
}

async function load() {
  state.lastLoad = Date.now();
  const d = await api("/api/dashboard");
  if (d.__auth === false) return;
  renderMe(d.me);
  if (d && d.empty) {
    state.cloud = true;
    state.d = { ...d, holdings: [], opportunities: [], alerts: [], news: [], portfolio: { base: "USD", baskets: [], rows: [], warnings: [] }, status: d.status || {} };
    $("#scanInfo").textContent = d.has_portfolio ? "הסריקה הראשונה של התיק שלך בדרך…" : "התיק ריק";
    showSections(false);
    $("#kpis").innerHTML = d.has_portfolio
      ? `<div class="kpi welcome"><div class="k-l">⏳ הסריקה הראשונה של התיק שלך בדרך</div><div class="k-s muted">התוצאות יופיעו כאן לבד תוך כמה דקות. אפשר להמשיך להוסיף מניות בינתיים.</div>
          <div class="row gap"><button class="btn small" onclick="holdingForm()">＋ פוזיציה</button><button class="btn small" onclick="watchForm()">＋ מעקב</button></div></div>`
      : `<div class="kpi welcome"><div class="k-l">👋 ${d.me ? `שלום ${esc(d.me.name)}, ` : ""}בוא נבנה את התיק שלך</div>
          <div class="k-s muted">הוסף את המניות שאתה מחזיק (כמות, מחיר ממוצע וסטופ) ומניות למעקב. המערכת תסרוק אותן ותתריע לך על הזדמנויות ועל זמן למכור.</div>
          <div class="row gap"><button class="btn primary" onclick="holdingForm()">＋ פוזיציה ראשונה</button><button class="btn" onclick="watchForm()">＋ מניה למעקב</button></div></div>`;
    return;
  }
  if (!d || !d.portfolio) return;
  showSections(true);
  state.cloud = d.mode === "cloud";
  if (state.cloud && state.d) {
    const seen = state.lastAlertTs || 0;
    d.alerts.filter((a) => a.ts > seen).reverse().forEach((a) => { toast(a); browserNotify(a); });
  }
  state.lastAlertTs = Math.max(0, ...d.alerts.map((a) => a.ts));
  state.d = d;
  render();
  fetchQuotes();
}

function render() {
  const d = state.d;
  $("#demoBanner").hidden = !d.demo;
  renderStatus(d.status);
  renderKPIs(d);
  renderDigest(d.digest);
  renderBrief(d.brief, d.indices);
  renderAlerts();
  renderBasketFilter();
  renderHoldings();
  renderAlloc(d.portfolio);
  renderEquity(d);
  renderOpps();
  renderDiscovery();
  renderNews();
  renderSocial();
  renderCongress();
  $("#unread").hidden = !d.unread;
  $("#unread").textContent = d.unread;
}

function renderStatus(s) {
  if (!s) return;
  const m = s.markets || {};
  const name = { open: "פתוח", extended: "מסחר מורחב", closed: "סגור" };
  $("#markets").innerHTML = `
    <span class="mkt ${m.us}"><i></i>ארה״ב · ${name[m.us] || "—"}</span>
    <span class="mkt ${m.tase}"><i></i>ת״א · ${name[m.tase] || "—"}</span>`;
  const last = s.last_scan ? new Date(s.last_scan * 1000).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }) : "—";
  if (state.cloud) {
    const auto = state.d?.auto;
    const qt = state.d?.quiet;
    const hm = (ms) => new Date(ms).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
    const dayName = (ms) => new Date(ms).toLocaleDateString("he-IL", { weekday: "long" });
    if (qt?.current) {
      $("#scanInfo").textContent = `🕯️ ${qt.current.title} – התראות וסריקות מושהות עד ${dayName(qt.current.end)} ${hm(qt.current.end)}`;
      $("#quietBanner").hidden = false;
      $("#quietBanner").textContent = `🕯️ ${qt.current.kind === "chag" ? "חג שמח" : "שבת שלום"} · ${qt.current.title} · ההתראות יחזרו במוצאי ${qt.current.kind === "chag" ? "החג" : "השבת"} (${hm(qt.current.end)}) עם סיכום המלצות`;
      return;
    }
    $("#quietBanner").hidden = true;
    const soon = qt?.enabled && qt?.upcoming && qt.upcoming.start - Date.now() < 18 * 3600_000 ? ` · 🕯️ ${qt.upcoming.kind === "chag" ? "החג" : "השבת"} נכנס${qt.upcoming.kind === "chag" ? "" : "ת"} ב‑${hm(qt.upcoming.candles || qt.upcoming.start)}` : "";
    const nextTxt = auto?.next ? ` · סריקה אוטומטית הבאה ~${new Date(auto.next).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}` : "";
    $("#scanInfo").textContent = `עודכן ${ago(s.last_scan)} (${last})${nextTxt}${soon}` + (s.last_error ? " · ⚠ שגיאה" : "") + (auto && auto.ok === false ? ` · ⚠ ${auto.error || "התזמון האוטומטי נכשל"}` : "");
    return;
  }
  const next = s.next_scan ? Math.max(0, Math.round((s.next_scan - Date.now() / 1000) / 60)) : null;
  $("#scanInfo").textContent = s.running ? "סורק עכשיו…" : `סריקה אחרונה ${last}` + (next != null ? ` · הבאה בעוד ${next} ד׳` : "") + (s.last_error ? " · ⚠ שגיאה" : "");
  $("#btnScan").classList.toggle("busy", !!s.running);
}

function renderKPIs(d) {
  const p = d.portfolio, b = p.base;
  const eqVals = (d.equity?.length > 5 ? d.equity.map((e) => e.value) : d.equity_backfill?.v) || [];
  const riskPct = p.risk_to_stop_pct;
  const avgScore = d.holdings.length ? d.holdings.reduce((a, h) => a + (h.score || 0), 0) / d.holdings.length : 0;
  const sells = d.holdings.filter((h) => ["SELL", "TRIM"].includes(h.action)).length;
  const items = [
    { l: "💼 שווי כולל", v: money(p.total, b), s: `מושקע ${money(p.value, b)}`, kc: css("--accent"), spark: eqVals },
    { l: "📅 רווח יומי", v: money(p.day_pnl, b), s: pct(p.day_pnl_pct), kc: p.day_pnl >= 0 ? css("--bull") : css("--bear"), sc: cls(p.day_pnl) },
    { l: "📊 רווח כולל", v: money(p.pnl, b), s: pct(p.total_pnl_pct), kc: p.pnl >= 0 ? css("--bull") : css("--bear"), sc: cls(p.pnl) },
    { l: "💵 מזומן", v: money(p.cash, b), s: `${nf(p.total ? p.cash / p.total * 100 : 0, 1)}% מהתיק`, kc: css("--info") },
    { l: "🛡️ סיכון עד הסטופים", v: money(p.risk_to_stop, b), s: `${nf(riskPct, 1)}% מהתיק`, kc: riskPct > 15 ? css("--bear") : riskPct > 8 ? css("--warn") : css("--bull") },
    { l: "🎯 ציון תיק", v: signed(avgScore), s: sells ? `${sells} איתותי יציאה` : "אין איתותי יציאה", kc: scoreColor(avgScore), sc: sells ? "down" : "" },
  ];
  $("#kpis").innerHTML = items.map((k) => `
    <div class="kpi" style="--kc:${k.kc}">
      <div class="k-l">${k.l}</div>
      <div class="k-v">${k.v}</div>
      <div class="k-s ${k.sc || "muted"}">${k.s}</div>
      ${k.spark?.length > 2 ? `<svg class="spark" viewBox="0 0 70 26" preserveAspectRatio="none"><path d="${sparkPath(k.spark, 70, 26)}" fill="none" stroke="${k.kc}" stroke-width="1.8" vector-effect="non-scaling-stroke"/></svg>` : ""}
    </div>`).join("");
}

function gauge(mood) {
  const v = Math.max(-100, Math.min(100, mood || 0));
  const cx = 100, cy = 100, r = 78;
  const arc = (a0, a1, col) => {
    const p = (a) => [cx + r * Math.cos(Math.PI * (1 - a)), cy - r * Math.sin(Math.PI * (1 - a))];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return `<path d="M${x0},${y0} A${r},${r} 0 0 1 ${x1},${y1}" stroke="${col}" stroke-width="16" fill="none"/>`;
  };
  const segs = [[0, .2, css("--bear")], [.205, .4, "#e0784a"], [.405, .595, css("--warn")], [.6, .795, "#7fcf5a"], [.8, 1, css("--bull")]];
  const a = (v + 100) / 200;
  const nx = cx + (r - 22) * Math.cos(Math.PI * (1 - a)), ny = cy - (r - 22) * Math.sin(Math.PI * (1 - a));
  return segs.map((s) => arc(...s)).join("") +
    `<line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="${css("--text")}" stroke-width="4" stroke-linecap="round"/>
     <circle cx="${cx}" cy="${cy}" r="8" fill="${css("--text")}"/>
     <text x="14" y="116" font-size="10" fill="${css("--muted")}">פחד</text><text x="186" y="116" font-size="10" text-anchor="end" fill="${css("--muted")}">חמדנות</text>`;
}

function renderBrief(b, idx) {
  if (!b) { $("#briefText").innerHTML = `<div class="empty">התדריך הראשון ייווצר בסיום הסריקה</div>`; return; }
  $("#moodGauge").innerHTML = gauge(b.mood);
  const m = b.mood || 0;
  $("#moodLabel").innerHTML = `<span class="num">${signed(m)}</span>` + (m > 40 ? "אופטימי מאוד" : m > 15 ? "חיובי" : m < -40 ? "פחד" : m < -15 ? "שלילי" : "ניטרלי");
  $("#moodLabel").style.color = scoreColor(m);
  $("#briefMeta").innerHTML = `${b.provider && b.provider !== "rules" ? `<span class="chip ai">🤖 ${esc(b.provider.split(":")[0])}</span>` : `<span class="chip">⚙️ חוקים</span>`} ${ago(b.ts)}`;
  $("#briefText").innerHTML = `
    <h3>${esc(b.title)}</h3><p>${esc(b.summary)}</p>
    ${b.focus?.length ? `<div class="chips">${b.focus.slice(0, 4).map((f) => `<span class="chip bull">🎯 ${esc(f)}</span>`).join("")}</div>` : ""}
    ${b.risks?.length ? `<div class="chips">${b.risks.slice(0, 3).map((f) => `<span class="chip bear">⚠ ${esc(f)}</span>`).join("")}</div>` : ""}
    ${b.actions?.length ? `<div class="chips">${b.actions.slice(0, 3).map((f) => `<span class="chip ai">✦ ${esc(f)}</span>`).join("")}</div>` : ""}`;
  $("#indices").innerHTML = Object.entries(idx || {}).map(([t, v]) => {
    const col = (t === "^VIX" ? -v.change_pct : v.change_pct) >= 0 ? css("--bull") : css("--bear");
    return `<div class="idx"><div class="n">${esc(v.label)}</div>
      <div class="v">${nf(v.price, 2)} <span class="${cls(t === "^VIX" ? -v.change_pct : v.change_pct)}">${pct(v.change_pct)}</span></div>
      <svg viewBox="0 0 100 22" preserveAspectRatio="none"><path d="${sparkPath(v.spark, 100, 22)}" fill="none" stroke="${col}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg></div>`;
  }).join("");
}

function alertHTML(a, isNew = false) {
  const t = new Date(a.ts * 1000);
  const time = t.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
  const day = t.toDateString() === new Date().toDateString() ? "" : t.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" }) + " ";
  return `<li class="alert lv-${a.level} ${isNew ? "new" : ""}" data-ticker="${esc(a.ticker || "")}">
    <div class="ico">${LEVEL[a.level]?.ico || "•"}</div>
    <div><div class="t">${a.ticker ? `<span class="tk">${esc(a.ticker)}</span> ` : ""}${esc(a.title)}</div>
      <div class="b">${esc(a.body)}</div>
      ${a.data?.sizing ? `<div class="chips"><span class="chip">כניסה ${nf(a.data.sizing.entry)}</span><span class="chip bear">סטופ ${nf(a.data.sizing.stop)}</span><span class="chip bull">יעד ${nf(a.data.sizing.target)}</span><span class="chip">${a.data.sizing.shares} יח׳</span></div>` : ""}
    </div>
    <div class="time">${day}${time}${a.score != null ? `<div class="num ${cls(a.score)}">${signed(a.score)}</div>` : ""}</div>
  </li>`;
}

function renderAlerts() {
  const f = state.alertFilter;
  const rows = state.d.alerts.filter((a) => f === "all" || a.level === f || (f === "critical" && a.level === "warning" && ["sell", "exit", "risk"].includes(a.kind)));
  $("#alertList").innerHTML = rows.length ? rows.map((a) => alertHTML(a)).join("") : `<div class="empty">אין התראות עדיין – המערכת מנטרת ברקע</div>`;
}

function renderBasketFilter() {
  const baskets = [...new Set(state.d.holdings.map((h) => h.basket).filter(Boolean))];
  $("#basketFilter").innerHTML = [`<button data-b="all" class="${state.basket === "all" ? "on" : ""}">הכל</button>`]
    .concat(baskets.map((b) => `<button data-b="${esc(b)}" class="${state.basket === b ? "on" : ""}">${esc(b)}</button>`)).join("");
}

function ring(score) {
  const s = score || 0, p = Math.min(100, Math.abs(s));
  const col = scoreColor(s);
  return `<div class="ring" style="background: conic-gradient(${col} ${p * 3.6}deg, ${css("--card-2")} 0)" title="ציון משוקלל"><span style="color:${col}">${signed(s)}</span></div>`;
}

function bbBar(ind) {
  const pb = ind?.bb_pctb;
  if (pb == null) return "";
  const pos = Math.max(-0.15, Math.min(1.15, pb));
  const left = ((pos + 0.15) / 1.3) * 100;
  const label = pb > 1 ? "מעל העליונה" : pb < 0 ? "מתחת לתחתונה" : pb > .8 ? "ליד העליונה" : pb < .2 ? "ליד התחתונה" : "באמצע";
  return `<div><div class="bar-lbl"><span>בולינגר: ${label}</span><span class="num">%B ${nf(pb, 2)}</span></div>
    <div class="bb-bar" title="מיקום המחיר בין הרצועה התחתונה לעליונה"><div class="bb-mid"></div><div class="dot" style="left:${left}%"></div></div></div>`;
}

function stopTargetBar(h, ind) {
  if (!h || !ind) return "";
  const stop = h.stop_loss || h.avg_price * 0.92, target = h.take_profit || Math.max(h.avg_price * 1.2, ind.price * 1.05);
  const span = target - stop || 1;
  const pos = Math.max(0, Math.min(100, (ind.price - stop) / span * 100));
  const avg = Math.max(0, Math.min(100, (h.avg_price - stop) / span * 100));
  return `<div><div class="bar-lbl"><span class="num">🛑 ${nf(stop)}</span><span>מסטופ ליעד</span><span class="num">🎯 ${nf(target)}</span></div>
    <div class="st-bar"><div class="avg" style="left:${avg}%" title="מחיר ממוצע"></div><div class="dot" style="left:${pos}%"></div></div></div>`;
}

function sigChips(sigs, n = 3) {
  return (sigs || []).slice().sort((a, b) => b.strength - a.strength).slice(0, n)
    .map((s) => `<span class="sig ${s.dir > 0 ? "p" : s.dir < 0 ? "n" : "z"}">${s.dir > 0 ? "▲" : s.dir < 0 ? "▼" : "◆"} ${esc(s.title.replace(/^[🛑🎯]\s*/u, ""))}</span>`).join("");
}

/* ------------------------------------------------------------------ Investing-style list rows */
const VIEW_KEY = "radar_view";
state.view = (() => { try { return localStorage.getItem(VIEW_KEY) || "list"; } catch (e) { return "list"; } })();

function quoteFor(s) {
  const q = state.quotes?.[s.ticker];
  const ind = s.ind || {};
  if (q && q.price != null) return q;
  return { price: ind.price, change: ind.price != null && ind.prev_close != null ? ind.price - ind.prev_close : null, change_pct: ind.change_pct,
    time: s.updated, live: false, currency: s.currency, spark: s.spark };
}

function qrowHTML(s, kind) {
  const q = quoteFor(s);
  const when = q.time ? (q.live ? fmtTime(q.time, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : fmtTime(q.time, { day: "2-digit", month: "2-digit" })) : "";
  const h = s.holding, pos = s.position || {};
  const dec = q.price >= 1000 ? 1 : q.price >= 10 ? 2 : 4;
  const extra = kind === "held"
    ? `<span class="q-pnl num ${cls(s.pnl_pct)}">${pct(s.pnl_pct, 1)}</span><span class="muted">${nf(h?.shares, 0)} יח׳ · ${money(pos.value, state.d.portfolio.base)}</span>`
    : (s.sizing?.entry ? `<span class="muted">כניסה ${nf(s.sizing.entry)}</span>` : "");
  const alarm = ["SELL", "TRIM"].includes(s.action);
  return `<div class="qrow ${alarm ? "alarm" : ""}" data-ticker="${esc(s.ticker)}">
    <div class="q-name"><b>${esc(hebName(s.ticker, s.name))}</b>
      <div class="q-sub"><span class="tkr" dir="ltr">${esc(s.ticker.replace(/\.TA$/, ""))}</span> | <span class="clk ${q.live ? "live" : ""}">◷</span> <span class="num">${esc(when)}</span></div>
      <div class="q-tags"><span class="action act-${s.action}">${ACTION_HE[s.action] || s.action || "—"}</span>${extra}</div></div>
    <div class="q-spark">${spark(q.spark || s.spark, 80, 30)}</div>
    <div class="q-price"><b class="num">${nf(q.price, dec)}</b>
      <div class="num ${cls(q.change)}">${signed(q.change, dec)} (${pct(q.change_pct)})</div></div>
  </div>`;
}

function viewToggleHTML() {
  return `<div class="seg view-seg"><button data-view="list" class="${state.view === "list" ? "on" : ""}" title="רשימה">☰</button><button data-view="cards" class="${state.view === "cards" ? "on" : ""}" title="כרטיסים">▦</button></div>`;
}

async function fetchQuotes() {
  if (!state.cloud || STATIC || document.hidden || loginShown || !state.d) return;
  const syms = [...(state.d.holdings || []), ...(state.d.opportunities || [])].map((x) => x.ticker);
  if (!syms.length) return;
  const q = await api(`/api/quotes?s=${encodeURIComponent(syms.join(","))}`);
  if (!q || q.error) return;
  const before = state.quotes || {};
  state.quotes = { ...before, ...q };
  renderHoldings(); renderOpps();
  for (const [t, v] of Object.entries(q)) {
    const old = before[t];
    if (old && old.price !== v.price) $$(`.qrow[data-ticker="${CSS.escape(t)}"]`).forEach((r) => r.classList.add(v.price > old.price ? "flash-up" : "flash-down"));
  }
}

function renderHoldings() {
  const list = state.d.holdings.filter((h) => state.basket === "all" || h.basket === state.basket)
    .sort((a, b) => (b.position?.value || 0) - (a.position?.value || 0));
  $("#holdings").classList.toggle("qlist", state.view === "list");
  if (state.view === "list") {
    $("#holdings").innerHTML = list.length ? list.map((h) => h.pending ? `<div class="qrow"><div class="q-name"><b>${esc(h.ticker)}</b><div class="q-sub">ממתין לסריקה…</div></div></div>` : qrowHTML(h, "held")).join("")
      : `<div class="empty">התיק ריק – הוסף פוזיציה ראשונה</div>`;
    $("#warnings").innerHTML = (state.d.portfolio.warnings || []).slice(0, 6).map((w) => `<div class="warn-row">⚠️ ${esc(w.text)}</div>`).join("");
    return;
  }
  $("#holdings").innerHTML = list.length ? list.map((h) => {
    if (h.pending) return `<div class="hcard skeleton"><div class="h-tk">${esc(h.ticker)}</div><div class="muted small">ממתין לסריקה…</div></div>`;
    const ind = h.ind || {}, pos = h.position || {}, ccy = h.currency;
    const alarm = ["SELL", "TRIM"].includes(h.action) || h.signals?.some((s) => s.cat === "exit" && s.strength >= .85);
    return `<div class="hcard ${alarm ? "alarm" : ""}" data-ticker="${esc(h.ticker)}">
      <div class="h-top">
        <div><div class="h-tk">${esc(h.ticker)}</div><div class="h-name">${esc(h.name)} · ${esc(h.basket || "")}</div></div>
        <span class="action act-${h.action}">${ACTION_HE[h.action] || h.action}</span>
      </div>
      <div class="h-mid">${ring(h.score)}
        <div><div class="h-price">${sym(ccy)}${nf(ind.price)} <span class="${cls(ind.change_pct)}" style="font-size:13px">${pct(ind.change_pct)}</span></div>${spark(h.spark)}</div>
      </div>
      <div class="h-stats">
        <div>רווח/הפסד<b class="${cls(h.pnl_pct)}">${pct(h.pnl_pct, 1)}</b></div>
        <div>שווי<b>${money(pos.value, state.d.portfolio.base)}</b></div>
        <div>RSI<b>${nf(ind.rsi, 0)}</b></div>
      </div>
      ${bbBar(ind)}
      ${stopTargetBar(h.holding, ind)}
      <div class="sig-row">${sigChips(h.signals) || `<span class="muted small">אין איתות בולט</span>`}</div>
    </div>`;
  }).join("") : `<div class="empty">התיק ריק – הוסף פוזיציה ראשונה</div>`;
  $("#warnings").innerHTML = (state.d.portfolio.warnings || []).slice(0, 6).map((w) => `<div class="warn-row">⚠️ ${esc(w.text)}</div>`).join("");
}

function basketColors() {
  const names = [...new Set((state.d.portfolio.baskets || []).map((b) => b.basket))].sort();
  const map = {};
  names.forEach((n, i) => { map[n] = i < 8 ? css(SERIES[i]) : css("--neutral"); });
  map["מזומן"] = css("--line-2");
  return map;
}

function renderAlloc(p) {
  const colors = basketColors();
  const parts = (p.baskets || []).map((b) => ({ name: b.basket, value: b.value, w: b.weight, day: b.day_pct, pnl: b.pnl_pct }));
  if (p.cash > 0) parts.push({ name: "מזומן", value: p.cash, w: p.cash / p.total * 100 });
  const total = parts.reduce((a, b) => a + b.value, 0) || 1;
  let a0 = -Math.PI / 2;
  const cx = 100, cy = 100, R = 88, r = 58;
  const paths = parts.map((pt) => {
    const a1 = a0 + (pt.value / total) * Math.PI * 2 - 0.02;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const P = (rad, a) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
    const d = `M${P(R, a0)} A${R},${R} 0 ${large} 1 ${P(R, a1)} L${P(r, a1)} A${r},${r} 0 ${large} 0 ${P(r, a0)} Z`;
    a0 = a1 + 0.02;
    return `<path d="${d}" fill="${colors[pt.name]}"><title>${esc(pt.name)} ${nf(pt.w, 1)}%</title></path>`;
  }).join("");
  $("#donut").innerHTML = paths + `<text x="100" y="96" text-anchor="middle" font-size="12" fill="${css("--muted")}">שווי כולל</text>
    <text x="100" y="116" text-anchor="middle" font-family="JetBrains Mono" font-weight="700" font-size="16" fill="${css("--text")}">${money(p.total, p.base)}</text>`;
  $("#allocLegend").innerHTML = parts.map((pt) => `<div class="al-row"><i style="background:${colors[pt.name]}"></i><span>${esc(pt.name)}</span>
    <span class="num">${nf(pt.w, 1)}%</span><span class="num ${cls(pt.day)}">${pt.day != null ? pct(pt.day) : ""}</span></div>`).join("");
  $("#treemap").innerHTML = (p.rows || []).slice().sort((a, b) => b.value - a.value).map((r) => {
    const h = state.d.holdings.find((x) => x.ticker === r.ticker);
    const day = h?.ind?.change_pct || 0;
    return `<div class="tile" data-ticker="${esc(r.ticker)}" style="flex-basis:${Math.max(70, r.weight * 9)}px; background:${divergingColor(day)}" title="${esc(r.ticker)} · ${nf(r.weight, 1)}% מהתיק">
      <b>${esc(r.ticker)}</b><span>${pct(day)}</span></div>`;
  }).join("");
}

function baseChartOpts(el, extra = {}) {
  return Object.assign({
    autoSize: true,
    layout: { background: { color: "transparent" }, textColor: css("--muted"), fontFamily: "Heebo", attributionLogo: false },
    grid: { vertLines: { color: "rgba(44,61,97,.25)" }, horzLines: { color: "rgba(44,61,97,.35)" } },
    rightPriceScale: { borderColor: css("--line") },
    timeScale: { borderColor: css("--line") },
    crosshair: { mode: 0 },
  }, extra);
}

function makeChart(key, el, opts) {
  if (state.charts[key]) { try { state.charts[key].remove(); } catch (e) { /* noop */ } }
  if (!window.LightweightCharts) { el.innerHTML = `<div class="empty">ספריית הגרפים לא נטענה</div>`; return null; }
  const c = LightweightCharts.createChart(el, baseChartOpts(el, opts));
  state.charts[key] = c;
  return c;
}

function renderEquity(d) {
  const el = $("#equityChart");
  let pts, label;
  if (d.equity?.length > 20) {
    pts = d.equity.map((e) => ({ time: Math.round(e.ts), value: e.value }));
    label = "היסטוריה בפועל";
  } else if (d.equity_backfill?.t?.length) {
    pts = d.equity_backfill.t.map((t, i) => ({ time: t, value: d.equity_backfill.v[i] }));
    label = "ההרכב הנוכחי לאורך זמן (שחזור)";
  } else { el.innerHTML = `<div class="empty">ההיסטוריה תיבנה עם הזמן</div>`; return; }
  el.innerHTML = "";
  const c = makeChart("equity", el, { timeScale: { borderColor: css("--line"), timeVisible: d.equity?.length > 20 } });
  if (!c) return;
  const up = pts[pts.length - 1].value >= pts[0].value;
  const col = up ? css("--bull") : css("--bear");
  const s = c.addAreaSeries({ lineColor: col, topColor: up ? "rgba(34,197,94,.30)" : "rgba(240,82,82,.30)", bottomColor: "rgba(0,0,0,0)", lineWidth: 2, priceLineVisible: false });
  s.setData(pts);
  c.timeScale().fitContent();
  const chg = (pts[pts.length - 1].value / pts[0].value - 1) * 100;
  $("#equityMeta").innerHTML = `${label} · <span class="num ${cls(chg)}">${pct(chg)}</span>`;
  const p = d.portfolio, r = p.risk_to_stop_pct || 0;
  const rc = r > 15 ? css("--bear") : r > 8 ? css("--warn") : css("--bull");
  $("#riskMeter").innerHTML = `
    <div class="bar-lbl"><span>🛡️ חשיפה עד הסטופים</span><span class="num">${nf(r, 1)}% · ${money(p.risk_to_stop, p.base)}</span></div>
    <div class="rm-track"><div class="rm-fill" style="width:${Math.min(100, r / 25 * 100)}%; background:${rc}"></div></div>
    <div class="bar-lbl"><span>מושקע מול מזומן</span><span class="num">${nf(p.value / p.total * 100, 0)}% / ${nf(p.cash / p.total * 100, 0)}%</span></div>
    <div class="rm-track"><div class="rm-fill" style="width:${p.value / p.total * 100}%; background:${css("--s1")}"></div></div>`;
}

function renderOpps() {
  const list = state.d.opportunities;
  $("#opps").classList.toggle("qlist", state.view === "list");
  if (state.view === "list") {
    $("#opps").innerHTML = list.length ? list.filter((o) => !o.pending).sort((a, b) => (b.score || 0) - (a.score || 0)).map((o) => qrowHTML(o, "watch")).join("")
      : `<div class="empty">הוסף מניות לרשימת המעקב כדי לקבל הזדמנויות</div>`;
    return;
  }
  $("#opps").innerHTML = list.length ? list.map((o) => {
    if (o.pending) return "";
    const sz = o.sizing || {}, a = o.analysis || {}, ind = o.ind || {};
    return `<div class="hcard opp" data-ticker="${esc(o.ticker)}">
      <div class="h-top"><div><div class="h-tk">${esc(o.ticker)}</div><div class="h-name">${esc(o.name)} · ${esc(o.basket || "")}</div></div>
        <span class="action act-${o.action}">${ACTION_HE[o.action] || o.action}</span></div>
      <div class="h-mid">${ring(o.score)}<div><div class="h-price">${sym(o.currency)}${nf(ind.price)} <span class="${cls(ind.change_pct)}" style="font-size:13px">${pct(ind.change_pct)}</span></div>${spark(o.spark)}</div></div>
      <div class="why">${esc(a.headline || o.top_signal || "")}</div>
      <div class="plan">
        <div>כניסה<b>${nf(sz.entry)}</b></div><div>סטופ<b class="down">${nf(sz.stop)}</b></div>
        <div>יעד<b class="up">${nf(sz.target)}</b></div><div>כמות<b>${sz.shares ?? "—"}</b></div>
      </div>
      ${bbBar(ind)}
      <div class="sig-row">${sigChips(o.signals) || `<span class="muted small">אין איתות בולט</span>`}</div>
    </div>`;
  }).join("") : `<div class="empty">הוסף מניות לרשימת המעקב כדי לקבל הזדמנויות</div>`;
}

function renderDigest(dg) {
  const sec = $("#digestSec");
  if (!dg || !state.cloud) { sec.hidden = true; return; }
  sec.hidden = false;
  $("#digestMeta").textContent = `${dg.title || ""} · ${ago(dg.ts)}`;
  $("#digestBody").innerHTML = (dg.sections || []).map((s) => `<div class="dg-sec"><h3>${esc(s.title)}</h3>
    ${(s.rows || []).map((r) => `<div class="dg-row" data-ticker="${esc(r.ticker)}">
      <span class="tk">${esc(r.ticker)}</span><span class="action act-${r.action}">${ACTION_HE[r.action] || r.action}</span>
      <span class="dg-why">${esc(r.why || "")}${r.entry ? `<span class="dg-plan">כניסה <b class="num">${nf(r.entry)}</b> · סטופ <b class="num down">${nf(r.stop)}</b> · יעד <b class="num up">${nf(r.target)}</b></span>` : ""}</span>
      <span class="num ${cls(r.pnl_pct ?? r.score)}">${r.pnl_pct != null ? pct(r.pnl_pct, 1) : signed(r.score)}</span></div>`).join("")}
    ${s.hold?.length ? `<div class="muted small dg-hold">⚪ להחזיק: ${s.hold.map(esc).join(", ")}</div>` : ""}</div>`).join("")
    || `<div class="empty">אין עדיין המלצות</div>`;
}

function renderDiscovery() {
  const sec = $("#discoverySec");
  const disc = state.d.discovery;
  if (!state.cloud || !disc) { sec.hidden = true; return; }
  sec.hidden = false;
  $("#discMeta").textContent = `עודכן ${ago(disc.ts)} · נסרקו ${disc.scanned || "—"} מניות`;
  $("#discovery").innerHTML = (disc.items || []).length ? disc.items.map((o, i) => {
    const sz = o.sizing || {}, a = o.analysis || {}, ind = o.ind || {};
    return `<div class="hcard opp disc" data-ticker="${esc(o.ticker)}">
      <span class="rank">#${i + 1}</span>
      <div class="h-top"><div><div class="h-tk">${esc(o.ticker)}</div><div class="h-name">${esc(o.name)}${o.fundamentals?.sector ? ` · ${esc(o.fundamentals.sector)}` : ""}</div></div>
        <span class="action act-${o.action}">${ACTION_HE[o.action] || o.action}</span></div>
      <div class="h-mid">${ring(o.score)}<div><div class="h-price">${sym(o.currency)}${nf(ind.price)} <span class="${cls(ind.change_pct)}" style="font-size:13px">${pct(ind.change_pct)}</span></div>${spark(o.spark)}</div></div>
      <div class="why">${esc(a.headline || o.top_signal || "")}</div>
      <div class="plan"><div>כניסה<b>${nf(sz.entry)}</b></div><div>סטופ<b class="down">${nf(sz.stop)}</b></div><div>יעד<b class="up">${nf(sz.target)}</b></div><div>R:R<b>1:${nf(sz.rr, 1)}</b></div></div>
      <div class="sig-row">${sigChips(o.signals)}</div>
      <button class="btn small" data-watch-add="${esc(o.ticker)}">👁 הוסף למעקב</button>
    </div>`;
  }).join("") : `<div class="empty">לא נמצאו כרגע הזדמנויות חזקות מחוץ לרשימות שלך</div>`;
  $$("#discovery [data-watch-add]").forEach((b) => b.onclick = (e) => { e.stopPropagation(); addToWatch(b.dataset.watchAdd, b); });
}

function renderNews() {
  const f = state.newsFilter;
  const rows = state.d.news.filter((n) => f === "all" || (f === "MARKET" ? n.ticker === "MARKET" : n.kind === f || (f === "news" && n.kind === "influencer")));
  $("#newsList").innerHTML = rows.length ? rows.slice(0, 40).map((n) => `
    <li class="news-item"><div class="sent" style="background:${n.sentiment > .15 ? css("--bull") : n.sentiment < -.15 ? css("--bear") : css("--line-2")}" title="סנטימנט ${nf(n.sentiment, 2)}"></div>
      <div><a class="nt" href="${esc(n.url)}" target="_blank" rel="noopener" style="color:inherit">${esc(n.title)}</a>
      <div class="nm">${n.ticker !== "MARKET" ? `<span class="tk">${esc(n.ticker)}</span>` : `<span class="chip">שוק</span>`}<span>${esc(n.source)}</span><span>${ago(n.ts)}</span>
        ${n.kind === "social" ? "<span>💬</span>" : n.kind === "influencer" ? "<span>⭐</span>" : ""}</div></div></li>`).join("")
    : `<div class="empty">אין חדשות עדיין</div>`;
}

function renderSocial() {
  const all = [...state.d.holdings, ...state.d.opportunities].filter((x) => x.social && (x.social.bull + x.social.bear) > 0)
    .sort((a, b) => (b.social.messages || 0) - (a.social.messages || 0)).slice(0, 10);
  $("#socialBars").innerHTML = all.length ? `<div class="bar-lbl"><span>מניה</span><span>▲ שוריים · דוביים ▼ (StockTwits)</span><span>Reddit</span></div>` + all.map((x) => {
    const b = x.social.bull, r = x.social.bear, t = b + r;
    return `<div class="sb" data-ticker="${esc(x.ticker)}"><span class="tk">${esc(x.ticker)}</span>
      <div class="sb-track" title="${b} שוריים / ${r} דוביים"><div class="b" style="width:${b / t * 100}%"></div><div class="r" style="width:${r / t * 100}%"></div></div>
      <span class="num muted small">${x.social.reddit_mentions ?? 0} 💬</span></div>`;
  }).join("") : `<div class="empty">אין נתוני רשתות (מניות ת״א לא מכוסות ב-StockTwits)</div>`;
}

function renderCongress() {
  const rows = [];
  [...state.d.holdings, ...state.d.opportunities].forEach((x) => (x.congress || []).forEach((c) => rows.push({ ...c, ticker: x.ticker })));
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  $("#congress").innerHTML = rows.length ? rows.slice(0, 10).map((c) => {
    const buy = /purchase|buy/i.test(c.type);
    return `<li><span class="tk">${esc(c.ticker)}</span><div><b>${esc(c.member)}</b> ${c.party ? `<span class="muted">(${esc(c.party)})</span>` : ""}<div class="muted small">${esc(c.amount)} · בוצע ${esc(c.date)}</div></div>
      <span class="chip ${buy ? "bull" : "bear"}">${buy ? "▲ קנייה" : "▼ מכירה"}</span></li>`;
  }).join("") : `<div class="empty">לא נמצאו דיווחים אחרונים</div>`;
}

function aiErrorsText(info) {
  const errs = Object.entries(info?.errors || {});
  if (!errs.length || info?.last_ok) return "";
  return `<div class="warn-row" style="margin-top:6px">⚠️ ה‑AI לא ענה בסריקה האחרונה – ${errs.map(([p, e]) => `${esc(p)}: ${esc(e)}`).join(" · ")}</div>`;
}

function aiStatusText(info) {
  if (!info) return "";
  if (info.mode === "own") return `✅ הניתוח שלך רץ על המפתח שלך (${(info.providers || []).join(", ")})`;
  if (info.mode === "none") return "⚙️ אין מפתח AI במערכת – ניתוח מבוסס חוקים";
  const left = Math.max(0, (info.daily_share || 0) - (info.used_today || 0));
  return `🔄 משתמש במפתח המשותף · נוצלו היום ${info.used_today || 0} מתוך ${info.daily_share || 0} ניתוחים` + (left ? "" : " – עד מחר ניתוח מבוסס חוקים");
}

/* ------------------------------------------------------------------ login (multi-user cloud mode) */
const AVATAR = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9", "#e66767", "#008300"];
const avatar = (u, size = 34) => `<span class="avatar" style="--av:${AVATAR[(u.color ?? 0) % 8]};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px">${esc((u.name || "?").trim().charAt(0))}</span>`;
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } };

let loginShown = false;
async function showLogin() {
  if (loginShown) return;
  loginShown = true;
  const info = await fetch("/api/users/public").then((r) => r.json()).catch(() => ({}));
  const users = Array.isArray(info) ? info : info.users || [];
  const googleOn = !!info.google_enabled;
  const urlErr = new URLSearchParams(location.search).get("login_error");
  if (urlErr) history.replaceState(null, "", location.pathname);
  let sel = users.find((u) => u.id === lsGet("radar_uid"))?.id || users[0]?.id;
  const gBtn = (label = "המשך עם Google") => `<a class="btn google-btn" href="/auth/google">
      <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
      <span>${label}</span></a>`;
  const el = document.createElement("div");
  el.className = "login";
  el.id = "login";
  const draw = () => {
    el.innerHTML = `<form class="login-card" id="loginForm">
      <div class="brand" style="justify-content:center"><svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" stroke-width="2" opacity=".35"/><circle cx="16" cy="16" r="8" fill="none" stroke="currentColor" stroke-width="2" opacity=".6"/><path d="M16 16 L27 9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><circle cx="23" cy="11" r="2.4" fill="var(--bull)"/></svg><div class="brand-name">רדאר מסחר</div></div>
      ${(() => { const cur = users.find((x) => x.id === sel) || {}; return googleOn && !(cur.google && !cur.password)
        ? `${gBtn()}<div class="login-or"><span>או בחר משתמש</span></div>` : `<div class="login-q">מי נכנס?</div>`; })()}
      <div class="login-tabs" role="tablist">${users.map((u) => `<button type="button" role="tab" aria-selected="${u.id === sel}" class="login-tab ${u.id === sel ? "on" : ""}" data-uid="${esc(u.id)}">${avatar(u, 44)}<span>${esc(u.name)}</span>${u.google ? `<small class="g-tag">Google</small>` : ""}</button>`).join("")}</div>
      ${(() => {
        const u = users.find((x) => x.id === sel) || {};
        if (u.google && !u.password) return `<div class="login-q">${esc(u.name)} נכנס עם חשבון Google</div>${gBtn(`המשך עם Google`)}<div class="login-err" id="loginErr" role="alert">${esc(urlErr || "")}</div>`;
        return `<label class="login-pw">סיסמה${u.google ? ` <span class="hint">(גיבוי למנהל)</span>` : ""}<input type="password" id="loginPw" autocomplete="current-password" required></label>
          <div class="login-err" id="loginErr" role="alert">${esc(urlErr || "")}</div>
          <button class="btn primary" id="loginBtn">כניסה</button>`;
      })()}
    </form>`;
    $$(".login-tab", el).forEach((b) => b.onclick = () => { sel = b.dataset.uid; draw(); $("#loginPw")?.focus(); });
    $$(".google-btn", el).forEach((a) => a.onclick = () => lsSet("radar_uid", sel));
    $("#loginForm", el).onsubmit = async (e) => {
      e.preventDefault();
      if (!$("#loginPw")) return;
      $("#loginBtn").disabled = true;
      const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: sel, password: $("#loginPw").value }) }).then((x) => x.json()).catch(() => ({ error: "אין חיבור" }));
      $("#loginBtn").disabled = false;
      if (r.error) { $("#loginErr").textContent = r.error; $("#loginPw").select(); return; }
      lsSet("radar_uid", sel);
      el.remove(); loginShown = false; state.d = null;
      await load();
      if (state.cloud && !state.poll) state.poll = setInterval(load, 60 * 1000);
    };
  };
  draw();
  document.body.appendChild(el);
  setTimeout(() => $("#loginPw")?.focus(), 50);
}

function renderMe(me) {
  const b = $("#btnMe");
  if (!me) { b.hidden = true; return; }
  b.hidden = false;
  b.innerHTML = `${avatar(me, 26)}<span class="lbl">${esc(me.name)}</span>`;
  state.me = me;
}

async function logout() {
  await api("/api/logout", { method: "POST" });
  closeModal();
  state.d = null;
  location.reload();
}

/* ------------------------------------------------------------------ stock drawer */
async function openStock(ticker) {
  if (!ticker) return;
  ticker = String(ticker).trim().toUpperCase();
  const s = await api(`/api/stock/${encodeURIComponent(ticker)}`);
  if (!s || s.error) { toast({ level: "warning", title: ticker, body: s?.error || "המניה עוד לא נסרקה" }); return; }
  state.stock = s;
  const ind = s.ind, ccy = s.currency;
  const tracked = s.source === "tracked" || (!s.source && !STATIC) || STATIC;
  $("#dTicker").textContent = hebName(s.ticker, s.name);
  $("#dName").innerHTML = `<span dir="ltr">(${esc(s.ticker)})</span>${s.basket ? ` · ${esc(s.basket)}` : ""}
    ${s.source === "discovery" ? ` <span class="chip bull">🔭 TOP ${s.rank || ""} גילוי</span>` : s.source === "live" ? ` <span class="chip">🔎 לא במעקב</span>` : ""}`;
  const q0 = state.quotes?.[s.ticker];
  setDrawerPrice(s, q0 || { price: ind.price, change: ind.price - (ind.prev_close || ind.price), change_pct: ind.change_pct, currency: ccy, time: s.updated, live: false });
  const h = s.holding, pos = s.position, sz = s.sizing || {};
  const lots = state.d?.lots?.filter((l) => l.ticker === s.ticker) || [];
  const f = s.fundamentals || {};
  const fm = [["מכפיל רווח", f.pe, 1], ["מכפיל עתידי", f.forward_pe, 1], ["צמיחת הכנסות", f.revenue_growth != null ? f.revenue_growth * 100 : null, 1, "%"],
    ["שולי רווח", f.profit_margin != null ? f.profit_margin * 100 : null, 1, "%"], ["יעד אנליסטים", f.target_mean, 2], ["המלצה", f.recommendation],
    ["בטא", f.beta, 2], ["דוחות הבאים", f.next_earnings], ["שווי שוק", f.market_cap ? f.market_cap / 1e9 : null, 1, "B"]].filter((x) => x[1] != null);

  const RANGE_BTNS = state.cloud ? [["1d", "1D"], ["5d", "1W"], ["1mo", "1M"], ["6mo", "6M"], ["1y", "1Y"], ["5y", "5Y"], ["max", "מקס׳"]] : [["snap", "6M"]];
  $("#dBody").innerHTML = `
    <div class="dtabs" role="tablist">
      <button class="on" data-pane="general">כללי</button><button data-pane="tech">ניתוח טכני</button>
      <button data-pane="analysts">אנליסטים</button><button data-pane="news">חדשות</button>
    </div>
    <div class="dpane on" data-pane="general">
    <div class="panel chart-panel">
      <div class="chart-legend"><span id="legendBB"><i style="background:${css("--s1")}"></i>בולינגר (20,2)</span><span id="legendMA"><i style="background:${css("--s4")}"></i>ממוצע 50 <i style="background:${css("--s6")}"></i>ממוצע 200</span><span id="ohlc" class="num"></span></div>
      <div class="price-chart" id="priceChart"></div>
      <div class="range-bar" id="rangeBar">
        ${RANGE_BTNS.map(([k, l]) => `<button data-range="${k}">${l}</button>`).join("")}
        <span class="rb-sep"></span>
        <button class="ctype" id="ctypeBtn" title="קו / נרות">${state.ctype === "candles" ? "📈 קו" : "🕯️ נרות"}</button>
        <button class="ctype ${state.showBB === false ? "" : "on"}" id="bbBtn" title="רצועות בולינגר">BB</button>
      </div>
      <div class="chart-legend" style="margin-top:8px"><span><i style="background:${css("--s3")}"></i>RSI (14)</span><span class="muted">30 / 70</span><span class="muted small" id="rangeNote"></span></div>
      <div class="rsi-chart" id="rsiChart"></div>
    </div>
    <div class="panel ai-box" id="aiBox">${aiBoxHTML(s)}</div>
    ${state.cloud ? chatPanelHTML(s) : ""}

    <div class="panel"><h3>📐 ${h ? "הפוזיציה שלך" : "תוכנית עסקה מוצעת"}</h3>
      <div class="metrics">
        ${h ? `
          <div class="metric"><div class="ml">כמות</div><div class="mv">${nf(h.shares, 0)}</div></div>
          <div class="metric"><div class="ml">מחיר ממוצע</div><div class="mv">${nf(h.avg_price)}</div></div>
          <div class="metric"><div class="ml">רווח/הפסד</div><div class="mv ${cls(s.pnl_pct)}">${pct(s.pnl_pct, 1)}</div></div>
          <div class="metric"><div class="ml">שווי</div><div class="mv">${money(pos?.value, state.d?.portfolio?.base)}</div></div>
          <div class="metric"><div class="ml">משקל בתיק</div><div class="mv">${nf(pos?.weight, 1)}%</div></div>
          <div class="metric"><div class="ml">סטופ לוס</div><div class="mv down">${nf(h.stop_loss)}</div></div>
          <div class="metric"><div class="ml">יעד רווח</div><div class="mv up">${nf(h.take_profit)}</div></div>
          <div class="metric"><div class="ml">סטופ נגרר</div><div class="mv">${h.trailing_pct ? nf(h.trailing_pct, 0) + "%" : "—"}</div></div>` : `
          <div class="metric"><div class="ml">כניסה</div><div class="mv">${nf(sz.entry)}</div></div>
          <div class="metric"><div class="ml">סטופ (${pct(sz.stop_pct, 1)})</div><div class="mv down">${nf(sz.stop)}</div></div>
          <div class="metric"><div class="ml">יעד (${pct(sz.target_pct, 1)})</div><div class="mv up">${nf(sz.target)}</div></div>
          <div class="metric"><div class="ml">כמות מוצעת</div><div class="mv">${sz.shares ?? "—"}</div></div>
          <div class="metric"><div class="ml">עלות</div><div class="mv">${money(sz.cost, state.d?.portfolio?.base)}</div></div>
          <div class="metric"><div class="ml">סיכון לעסקה</div><div class="mv">${money(sz.risk_amount, state.d?.portfolio?.base)}</div></div>
          <div class="metric"><div class="ml">יחס סיכוי:סיכון</div><div class="mv">1:${nf(sz.rr, 1)}</div></div>
          <div class="metric"><div class="ml">מוגבל ע״י</div><div class="mv" style="font-family:Heebo;direction:rtl">${{ risk: "סיכון", max_position: "משקל מקס׳", cash: "מזומן" }[sz.limited_by] || "—"}</div></div>`}
      </div>
      ${(s.risk_issues || []).length && !h ? `<div class="warnings">${s.risk_issues.map((x) => `<div class="warn-row">⚠️ ${esc(x)}</div>`).join("")}</div>` : ""}
      <div class="row gap" style="margin-top:12px;flex-wrap:wrap">
        ${h ? lots.map((l) => `<button class="btn small" data-edit-lot="${l.id}">✏️ ערוך${lots.length > 1 ? ` (${nf(l.shares, 0)} יח׳)` : ""}</button>`).join("") : `<button class="btn small primary" data-add-from="${esc(s.ticker)}">＋ הוסף לתיק</button>`}
        ${!h && !s.watching && s.source && s.source !== "tracked" ? `<button class="btn small" data-watch-add="${esc(s.ticker)}">👁 הוסף למעקב</button>` : ""}
        ${state.d?.features?.broker && !s.ticker.endsWith(".TA") ? `<button class="btn small" data-order="${esc(s.ticker)}">📤 שלח פקודה (Paper)</button>` : ""}
      </div>
    </div>

    </div>
    <div class="dpane" data-pane="tech">
    <div class="panel"><h3>📡 איתותים פעילים</h3>
      <div class="sig-list">${(s.signals || []).length ? s.signals.slice().sort((x, y) => y.strength - x.strength).map((g) => `
        <div class="sig-item"><div class="si">${g.dir > 0 ? "🟢" : g.dir < 0 ? "🔴" : "🟣"}</div>
          <div><b>${esc(g.title)}</b><div class="sd">${esc(g.desc)}</div></div>
          <div class="strength" title="עוצמה ${Math.round(g.strength * 100)}%"><div style="width:${g.strength * 100}%;background:${g.dir > 0 ? css("--bull") : g.dir < 0 ? css("--bear") : css("--ai")}"></div></div></div>`).join("")
        : `<div class="empty">אין איתות פעיל – המניה בטווח</div>`}</div>
    </div>

    <div class="panel"><h3>📊 נתונים</h3>
      <div class="metrics">
        <div class="metric"><div class="ml">RSI</div><div class="mv">${nf(ind.rsi, 0)}</div></div>
        <div class="metric"><div class="ml">%B בולינגר</div><div class="mv">${nf(ind.bb_pctb, 2)}</div></div>
        <div class="metric"><div class="ml">רוחב רצועות (אחוזון)</div><div class="mv">${nf(ind.bb_bw_pctl, 0)}</div></div>
        <div class="metric"><div class="ml">ATR</div><div class="mv">${nf(ind.atr)}</div></div>
        <div class="metric"><div class="ml">נפח יחסי</div><div class="mv">×${nf(ind.vol_ratio, 1)}</div></div>
        <div class="metric"><div class="ml">מהשיא השנתי</div><div class="mv ${cls(ind.dist_52w_high_pct)}">${pct(ind.dist_52w_high_pct, 1)}</div></div>
        <div class="metric"><div class="ml">5 ימים</div><div class="mv ${cls(ind.change_5d_pct)}">${pct(ind.change_5d_pct, 1)}</div></div>
        <div class="metric"><div class="ml">חודש</div><div class="mv ${cls(ind.change_1m_pct)}">${pct(ind.change_1m_pct, 1)}</div></div>
        ${fm.map((x) => `<div class="metric"><div class="ml">${x[0]}</div><div class="mv">${typeof x[1] === "number" ? nf(x[1], x[2]) + (x[3] || "") : esc(x[1])}</div></div>`).join("")}
      </div>
    </div>

    <div class="panel"><h3>⏳ מכונת זמן – בדיקת אסטרטגיה</h3>
      <div class="bt-controls">
        <select id="btStrategy"><option value="bb_reversion">בולינגר – חזרה לממוצע</option><option value="bb_breakout">בולינגר – פריצה מסחיטה</option><option value="sma_cross">צלב ממוצעים 50/200</option><option value="rsi_reversion">RSI 30/70</option></select>
        <select id="btYears"><option value="2">שנתיים</option><option value="3" selected>3 שנים</option><option value="5">5 שנים</option></select>
        <button class="btn small primary" id="btRun">הרץ</button>
      </div>
      <div id="btOut"><div class="muted small">בדוק איך האסטרטגיה הייתה מתפקדת על המניה הזו בעבר, מול קנה-והחזק.</div></div>
    </div>

    </div>
    <div class="dpane" data-pane="analysts">${yfPanelHTML(s) || `<div class="panel empty">אין נתוני אנליסטים למניה הזו (נפוץ במניות קטנות ובחלק ממניות ת״א)</div>`}</div>
    <div class="dpane" data-pane="news">
    <div class="panel"><h3>📰 חדשות ורשתות</h3>
      <ul class="news-list">${(s.news_items || []).map((n) => `<li class="news-item"><div class="sent" style="background:${n.sentiment > .15 ? css("--bull") : n.sentiment < -.15 ? css("--bear") : css("--line-2")}"></div>
        <div><a class="nt" href="${esc(n.url)}" target="_blank" rel="noopener" style="color:inherit">${esc(n.title)}</a><div class="nm"><span>${esc(n.source)}</span><span>${ago(n.ts)}</span></div></div></li>`).join("") || `<div class="empty">אין חדשות</div>`}</ul>
    </div>
    ${s.congress?.length ? `<div class="panel"><h3>🏛️ עסקאות קונגרס</h3><ul class="congress">${s.congress.map((c) => `<li><span>${/purchase|buy/i.test(c.type) ? "🟢" : "🔴"}</span><div><b>${esc(c.member)}</b> <span class="muted">${esc(c.party)}</span><div class="muted small">${esc(c.amount)}</div></div><span class="small muted">${esc(c.date)}</span></li>`).join("")}</ul></div>` : ""}
    </div>
  `;
  $$(".dtabs button").forEach((b) => b.onclick = () => {
    $$(".dtabs button").forEach((x) => x.classList.toggle("on", x === b));
    $$(".dpane").forEach((p) => p.classList.toggle("on", p.dataset.pane === b.dataset.pane));
    $(".drawer-panel").scrollTop = 0;
  });
  $("#drawer").hidden = false;
  document.body.style.overflow = "hidden";
  $$("#rangeBar [data-range]").forEach((b) => b.onclick = () => drawChart(s, b.dataset.range));
  $("#ctypeBtn").onclick = () => { state.ctype = state.ctype === "candles" ? "area" : "candles"; $("#ctypeBtn").textContent = state.ctype === "candles" ? "📈 קו" : "🕯️ נרות"; drawChart(s, state.range); };
  $("#bbBtn").onclick = () => { state.showBB = state.showBB === false; $("#bbBtn").classList.toggle("on", state.showBB); drawChart(s, state.range); };
  drawChart(s, state.cloud ? (state.range && state.range !== "snap" ? state.range : "1d") : "snap");
  $("#btRun").onclick = () => runBacktest(s.ticker);
  $$("[data-edit-lot]").forEach((b) => b.onclick = () => holdingForm(state.d.lots.find((l) => l.id === +b.dataset.editLot)));
  $$("[data-add-from]").forEach((b) => b.onclick = () => holdingForm({ ticker: b.dataset.addFrom, avg_price: sz.entry, stop_loss: sz.stop, take_profit: sz.target, shares: sz.shares, basket: s.basket }));
  $$("[data-order]").forEach((b) => b.onclick = () => orderForm(s));
  $$("[data-watch-add]").forEach((b) => b.onclick = () => addToWatch(b.dataset.watchAdd, b));
  bindAIBox(s);
  if (state.cloud) bindChat(s);
  history.replaceState(null, "", `?ticker=${encodeURIComponent(s.ticker)}`);
  // every stock gets a recommendation – ask the AI when there is no AI analysis yet
  if (state.cloud && (!s.analysis || !s.analysis.provider || s.analysis.provider === "rules") && s.source !== "tracked") fetchRecommendation(s);
}

function yfPanelHTML(s) {
  const y = s.yf || {};
  const a = y.analyst || {}, r = y.ratings, price = s.ind?.price;
  if (!a.target_mean && !r && !(y.changes || []).length && !y.next_earnings) return "";
  const RAT = [["strongBuy", "קנייה חזקה", css("--bull")], ["buy", "קנייה", "#7fcf5a"], ["hold", "החזקה", css("--warn")], ["sell", "מכירה", "#e0784a"], ["strongSell", "מכירה חזקה", css("--bear")]];
  const tot = r ? RAT.reduce((sum, [k]) => sum + (r[k] || 0), 0) : 0;
  const up = a.target_mean && price ? (a.target_mean / price - 1) * 100 : null;
  // position of current price and mean target on the low..high target range
  const lo = a.target_low, hi = a.target_high, span = hi && lo ? hi - lo : 0;
  const pos = (v) => (span ? Math.max(0, Math.min(100, ((v - lo) / span) * 100)) : 50);
  const ACT = { up: "⬆ שדרוג", upgrade: "⬆ שדרוג", down: "⬇ הורדה", downgrade: "⬇ הורדה", init: "✦ התחלת כיסוי", main: "= שמירה", reit: "= שמירה" };
  return `<div class="panel yf-panel"><h3>🏦 אנליסטים ודוחות <span class="chip">Yahoo Finance</span></h3>
    ${r && tot ? `<div class="bar-lbl"><span>המלצות ${tot} אנליסטים</span><span class="num">${a.mean_rating ? `דירוג ${nf(a.mean_rating, 2)} / 5` : ""}</span></div>
      <div class="rat-bar">${RAT.map(([k, l, c]) => r[k] ? `<div style="flex:${r[k]};background:${c}" title="${l}: ${r[k]}"><span>${r[k]}</span></div>` : "").join("")}</div>
      <div class="rat-legend">${RAT.map(([k, l, c]) => `<span><i style="background:${c}"></i>${l}</span>`).join("")}</div>` : ""}
    ${a.target_mean ? `<div class="bar-lbl" style="margin-top:12px"><span>מחיר יעד ממוצע <b class="num">${nf(a.target_mean)}</b></span><span class="num ${cls(up)}">${up != null ? pct(up, 1) : ""} מהמחיר</span></div>
      ${span ? `<div class="tgt-bar"><div class="tgt-mean" style="left:${pos(a.target_mean)}%" title="יעד ממוצע"></div><div class="dot" style="left:${pos(price)}%" title="מחיר נוכחי"></div></div>
      <div class="bar-lbl" style="direction:ltr"><span class="num">${nf(lo)}</span><span class="muted" dir="rtl">טווח יעדים · ● מחיר נוכחי · ▮ יעד ממוצע</span><span class="num">${nf(hi)}</span></div>` : ""}` : ""}
    <div class="metrics" style="margin-top:10px">
      ${y.next_earnings ? `<div class="metric"><div class="ml">דוחות הבאים</div><div class="mv">${esc(y.next_earnings)}</div></div>` : ""}
      ${y.eps_estimate != null ? `<div class="metric"><div class="ml">צפי EPS</div><div class="mv">${nf(y.eps_estimate)}</div></div>` : ""}
      ${(y.eps_history || []).slice(0, 4).map((e) => `<div class="metric"><div class="ml">הפתעת EPS ${esc((e.quarter || "").slice(0, 7))}</div><div class="mv ${cls(e.surprise_pct)}">${pct(e.surprise_pct, 1)}</div></div>`).join("")}
      ${y.ownership?.institutions_pct != null ? `<div class="metric"><div class="ml">מוסדיים</div><div class="mv">${nf(y.ownership.institutions_pct * 100, 1)}%</div></div>` : ""}
      ${y.ownership?.short_pct_float != null ? `<div class="metric"><div class="ml">שורט מהמניות הצפות</div><div class="mv">${nf(y.ownership.short_pct_float * 100, 1)}%</div></div>` : ""}
    </div>
    ${(y.changes || []).length ? `<div class="small muted" style="margin:12px 0 6px">שינויי דירוג (60 יום)</div><table class="t"><tbody>${y.changes.slice(0, 6).map((c) => `<tr>
      <td class="num">${esc(c.date || "")}</td><td>${esc(c.firm || "")}</td><td class="${/up/.test(c.action) ? "up" : /down/.test(c.action) ? "down" : ""}">${ACT[c.action] || esc(c.action)}</td>
      <td>${esc(c.to || "")}</td><td class="num">${c.target ? nf(c.target) : ""}</td></tr>`).join("")}</tbody></table>` : ""}
    ${(y.insiders || []).length ? `<div class="small muted" style="margin:12px 0 6px">עסקאות בעלי עניין</div><div class="chips">${y.insiders.slice(0, 6).map((i) => `<span class="chip ${i.kind === "buy" ? "bull" : i.kind === "sell" ? "bear" : ""}">${i.kind === "buy" ? "▲ קנייה" : i.kind === "sell" ? "▼ מכירה" : "•"} ${esc(i.role || i.who || "")} ${esc(i.date || "")}</span>`).join("")}</div>` : ""}
  </div>`;
}

function aiBoxHTML(s, loading = false, err = "") {
  const a = s.analysis || {};
  const isAI = a.provider && a.provider !== "rules";
  return `
    <div class="ai-head"><h3>🤖 המלצה ${isAI ? `<span class="chip ai">${esc(a.provider.split(":")[0])}</span>` : `<span class="chip">חוקים</span>`}</h3>
      <div class="row gap"><span class="action act-${s.action}">${ACTION_HE[s.action] || s.action || "—"}</span>
        <div class="conf">ביטחון <div class="conf-track"><div style="width:${a.confidence || 0}%"></div></div><span class="num">${a.confidence || 0}%</span></div></div></div>
    ${loading ? `<div class="ai-loading"><span class="dots"><i></i><i></i><i></i></span> ה‑AI מנתח את ${esc(s.ticker)}…</div>` : ""}
    ${err ? `<div class="warn-row" style="margin-top:8px">${esc(err)}</div>` : ""}
    ${a.headline || a.summary ? `<p style="margin:10px 0 4px;font-weight:600">${esc(a.headline || "")}</p>
      <p style="margin:0 0 10px;color:var(--text-2)">${esc(a.summary || "")}</p>
      <div class="two-col"><div><div class="small muted">בעד</div><ul class="pros">${(a.bull || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>—</li>"}</ul></div>
        <div><div class="small muted">סיכונים</div><ul class="cons">${(a.bear || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>—</li>"}</ul></div></div>
      ${a.entry || a.stop || a.target ? `<div class="chips" style="margin-top:8px">${a.entry ? `<span class="chip">כניסה ${nf(a.entry)}</span>` : ""}${a.stop ? `<span class="chip bear">סטופ ${nf(a.stop)}</span>` : ""}${a.target ? `<span class="chip bull">יעד ${nf(a.target)}</span>` : ""}${a.horizon ? `<span class="chip">טווח: ${esc(a.horizon)}</span>` : ""}</div>` : ""}`
      : loading ? "" : `<p class="muted small" style="margin:10px 0">${s.top_signal ? `איתות מוביל: ${esc(s.top_signal)}` : "אין עדיין ניתוח AI למניה הזו."}</p>`}
    <div class="row gap" style="justify-content:space-between;margin-top:8px;flex-wrap:wrap">
      <span class="muted small">${s.analysis_ts ? `עודכן ${ago(s.analysis_ts)} · ` : ""}ציון טכני ${signed(s.tech_score ?? s.score)}${s.news_sentiment != null ? ` · סנטימנט חדשות ${signed((s.news_sentiment || 0) * 100)}` : ""}</span>
      ${state.cloud && !loading ? `<button class="btn small" id="recBtn">🔄 המלצה עדכנית מה‑AI</button>` : ""}
    </div>`;
}

function bindAIBox(s) {
  const b = $("#recBtn");
  if (b) b.onclick = () => fetchRecommendation(s, true);
}

async function fetchRecommendation(s, force = false) {
  $("#aiBox").innerHTML = aiBoxHTML(s, true);
  const r = await api(`/api/recommend/${encodeURIComponent(s.ticker)}`, { method: "POST", body: { force } });
  if (state.stock?.ticker !== s.ticker) return;
  if (r.error) { $("#aiBox").innerHTML = aiBoxHTML(s, false, r.error); bindAIBox(s); return; }
  s.analysis = r.analysis; s.action = r.analysis.action; s.analysis_ts = r.analysis.ts || Date.now() / 1000;
  $("#aiBox").innerHTML = aiBoxHTML(s);
  bindAIBox(s);
}

async function addToWatch(ticker, btn) {
  const r = await api("/api/watchlist", { method: "POST", body: { ticker, basket: "מעקב" } });
  if (r.error) return toast({ level: "warning", title: "שגיאה", body: r.error });
  if (btn) { btn.disabled = true; btn.textContent = "✓ במעקב"; }
  toast({ level: "opportunity", title: `${ticker} נוסף למעקב`, body: "יופיע ברשימת המעקב אחרי הסריקה הבאה" });
  setTimeout(load, 2500);
}

/* ------------------------------------------------------------------ ask about a stock */
const CHAT_SUGGEST = {
  held: ["כדאי להגדיל או לממש?", "איפה כדאי להזיז את הסטופ?", "מה הסיכון הכי גדול כרגע?", "מה אומרות החדשות האחרונות?"],
  free: ["כדאי לקנות עכשיו?", "איפה נקודת כניסה טובה?", "מה הסיכונים?", "מה אומרות החדשות האחרונות?"],
};

function chatPanelHTML(s) {
  const hist = (state.chat ||= {})[s.ticker] || [];
  const sugg = CHAT_SUGGEST[s.holding ? "held" : "free"];
  return `<div class="panel chat-panel">
    <h3>💬 שאל על ${esc(s.ticker)}</h3>
    <div class="chat-log" id="chatLog" aria-live="polite">${hist.length ? hist.map(chatMsgHTML).join("") : `<div class="muted small">שאל כל שאלה בשפה חופשית – ה‑AI עונה לפי הנתונים, האיתותים, החדשות והפוזיציה שלך.</div>`}</div>
    <div class="chips chat-sugg">${sugg.map((q) => `<button type="button" class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>
    <form class="chat-form" id="chatForm"><input type="text" id="chatInput" maxlength="500" placeholder="למשל: מה דעתך על הדוחות הקרובים?" autocomplete="off"><button class="btn primary" id="chatSend">שלח</button></form>
  </div>`;
}

function chatMsgHTML(m) {
  return `<div class="msg ${m.role}">${m.role === "assistant" ? `<div class="who">🤖 ${esc((m.provider || "AI").split(":")[0])}</div>` : ""}<div class="bubble">${esc(m.text).replace(/\n/g, "<br>")}</div></div>`;
}

function bindChat(s) {
  const send = async (q) => {
    q = (q || "").trim();
    if (!q) return;
    const hist = (state.chat[s.ticker] ||= []);
    hist.push({ role: "user", text: q });
    const log = $("#chatLog");
    log.innerHTML = hist.map(chatMsgHTML).join("") + `<div class="msg assistant"><div class="bubble"><span class="dots"><i></i><i></i><i></i></span></div></div>`;
    log.scrollTop = log.scrollHeight;
    $("#chatInput").value = ""; $("#chatSend").disabled = true;
    const r = await api("/api/ask", { method: "POST", body: { ticker: s.ticker, question: q, history: hist.slice(0, -1) } });
    $("#chatSend").disabled = false;
    if (r.error) { hist.pop(); toast({ level: "warning", title: "לא התקבלה תשובה", body: r.error }); }
    else hist.push({ role: "assistant", text: r.answer, provider: r.provider });
    if (state.stock?.ticker !== s.ticker) return;
    log.innerHTML = hist.length ? hist.map(chatMsgHTML).join("") : "";
    log.scrollTop = log.scrollHeight;
    $("#chatInput").focus();
  };
  $("#chatForm").onsubmit = (e) => { e.preventDefault(); send($("#chatInput").value); };
  $$(".chat-sugg [data-q]").forEach((b) => b.onclick = () => send(b.dataset.q));
}

/* ------------------------------------------------------------------ price chart with time ranges */
const IL_TZ = "Asia/Jerusalem";
function smaA(a, n) { return a.map((_, i) => (i + 1 < n ? null : a.slice(i + 1 - n, i + 1).reduce((x, y) => x + y, 0) / n)); }
function bbA(a, n = 20, k = 2) {
  const m = smaA(a, n);
  return a.map((_, i) => {
    if (m[i] == null) return [null, null, null];
    const w = a.slice(i + 1 - n, i + 1), sd = Math.sqrt(w.reduce((s, v) => s + (v - m[i]) ** 2, 0) / n);
    return [m[i] + k * sd, m[i], m[i] - k * sd];
  });
}
function rsiA(c, n = 14) {
  const out = Array(c.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; if (i === n) out[i] = l ? 100 - 100 / (1 + g / l) : 100; continue; }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = l ? 100 - 100 / (1 + g / l) : 100;
  }
  return out;
}
const fmtTime = (ts, opts) => new Date(ts * 1000).toLocaleString("he-IL", { timeZone: IL_TZ, ...opts });

function setDrawerPrice(s, q) {
  if (!q || q.price == null) return;
  const up = (q.change ?? 0) >= 0;
  const when = q.time ? (q.live ? `מסחר חי · ${fmtTime(q.time, { hour: "2-digit", minute: "2-digit" })}`
    : `${fmtTime(q.time, { day: "2-digit", month: "2-digit" })} - בהשהייה`) : "";
  $("#dPrice").innerHTML = `<div class="dp-main"><span class="dp-arrow ${up ? "up" : "down"}">${up ? "▲" : "▼"}</span><b class="num">${nf(q.price, q.price >= 1000 ? 0 : 2)}</b></div>
    <div class="dp-chg num ${up ? "up" : "down"}">${signed(q.change, Math.abs(q.change) >= 100 ? 0 : 2)} (${pct(q.change_pct)})</div>
    <div class="dp-when"><span class="clk ${q.live ? "live" : ""}">◷</span> ${esc(when)}${q.currency ? ` · מטבע ${esc(q.currency)}` : ""}</div>`;
}

async function drawChart(s, range) {
  state.range = range;
  $$("#rangeBar [data-range]").forEach((b) => b.classList.toggle("on", b.dataset.range === range));
  let bars = null, intraday = false, meta = null;
  if (range !== "snap" && state.cloud) {
    $("#rangeNote").textContent = "טוען…";
    const h = await api(`/api/chart/${encodeURIComponent(s.ticker)}?range=${range}`);
    if (state.stock?.ticker !== s.ticker || state.range !== range) return;
    if (h && !h.error && h.c?.length > 1) { bars = h; intraday = h.intraday; meta = h.meta; }
  }
  if (!bars) { // the scanner's daily snapshot (~8 months)
    const ch = s.chart || { t: [], o: [], h: [], l: [], c: [], v: [] };
    bars = { t: ch.t, o: ch.o, h: ch.h, l: ch.l, c: ch.c, v: ch.v };
    if (range !== "snap" && state.cloud) $("#rangeNote").textContent = "· הטווח לא זמין – מוצגים נתוני הסריקה";
  } else $("#rangeNote").textContent = intraday ? `· נרות ${bars.interval}` : "";
  if (meta) {
    setDrawerPrice(s, meta);
    if (range === "1d") state.quotes = { ...(state.quotes || {}), [s.ticker]: { ...(state.quotes?.[s.ticker] || {}), ...meta } };
  }
  const toTime = (t) => (typeof t === "number" ? (intraday ? t : new Date(t * 1000).toISOString().slice(0, 10)) : t);
  const pts = bars.t.map((t, i) => ({ time: toTime(t), o: bars.o[i], h: bars.h[i], l: bars.l[i], c: bars.c[i], v: bars.v[i] }))
    .filter((p, i, a) => p.c != null && (i === 0 || String(p.time) !== String(a[i - 1].time)));
  if (!pts.length) return;
  const closes = pts.map((p) => p.c);
  const first = range === "1d" && meta?.prev_close ? meta.prev_close : closes[0];
  const upMove = closes[closes.length - 1] >= first;

  const el = $("#priceChart");
  const c = makeChart("price", el, {
    timeScale: { borderColor: css("--line"), timeVisible: intraday, secondsVisible: false,
      tickMarkFormatter: (t) => (typeof t === "number" ? fmtTime(t, range === "1d" ? { hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "2-digit", hour: "2-digit" }) : undefined) },
    localization: { locale: "he-IL", timeFormatter: (t) => (typeof t === "number" ? fmtTime(t, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : typeof t === "string" ? t.split("-").reverse().join(".") : `${t.day}.${t.month}.${t.year}`) },
    handleScroll: true, handleScale: true,
  });
  if (!c) return;
  let main;
  if (state.ctype === "candles") {
    main = c.addCandlestickSeries({ upColor: css("--bull"), downColor: css("--bear"), borderVisible: false, wickUpColor: css("--bull"), wickDownColor: css("--bear") });
    main.setData(pts.map((p) => ({ time: p.time, open: p.o, high: p.h, low: p.l, close: p.c })));
  } else {
    const col = upMove ? css("--bull") : css("--bear");
    main = c.addAreaSeries({ lineColor: col, topColor: upMove ? "rgba(34,197,94,.28)" : "rgba(240,82,82,.28)", bottomColor: "rgba(0,0,0,0)", lineWidth: 2 });
    main.setData(pts.map((p) => ({ time: p.time, value: p.c })));
  }
  const line = (vals, color, opts = {}) => {
    const sr = c.addLineSeries(Object.assign({ color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, opts));
    sr.setData(pts.map((p, i) => ({ time: p.time, value: vals[i] })).filter((x) => x.value != null));
  };
  if (state.showBB !== false && pts.length > 25) {
    const bb = bbA(closes);
    line(bb.map((x) => x[0]), css("--s1")); line(bb.map((x) => x[1]), css("--s1"), { lineStyle: 2, lineWidth: 1 }); line(bb.map((x) => x[2]), css("--s1"));
  }
  const showMA = !intraday && pts.length > 60;
  if (showMA) { line(smaA(closes, 50), css("--s4")); if (pts.length > 200) line(smaA(closes, 200), css("--s6")); }
  $("#legendBB").hidden = state.showBB === false;
  $("#legendMA").hidden = !showMA;
  const vol = c.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
  c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
  vol.setData(pts.map((p) => ({ time: p.time, value: p.v || 0, color: p.c >= p.o ? "rgba(34,197,94,.3)" : "rgba(240,82,82,.3)" })));
  if (range === "1d" && meta?.prev_close) main.createPriceLine({ price: meta.prev_close, color: css("--muted"), lineWidth: 1, lineStyle: 2, title: "סגירה קודמת" });
  const h = s.holding;
  if (h) {
    if (h.stop_loss) main.createPriceLine({ price: h.stop_loss, color: css("--bear"), lineWidth: 1, lineStyle: 2, title: "סטופ" });
    if (h.take_profit) main.createPriceLine({ price: h.take_profit, color: css("--bull"), lineWidth: 1, lineStyle: 2, title: "יעד" });
    main.createPriceLine({ price: h.avg_price, color: css("--text-2"), lineWidth: 1, lineStyle: 1, title: "ממוצע" });
  } else if (s.sizing?.stop && !intraday) {
    main.createPriceLine({ price: s.sizing.stop, color: css("--bear"), lineWidth: 1, lineStyle: 2, title: "סטופ מוצע" });
    main.createPriceLine({ price: s.sizing.target, color: css("--bull"), lineWidth: 1, lineStyle: 2, title: "יעד מוצע" });
  }
  c.timeScale().fitContent();
  c.subscribeCrosshairMove((p) => {
    const i = p?.time != null ? pts.findIndex((x) => String(x.time) === String(p.time)) : -1;
    if (i < 0) { $("#ohlc").textContent = ""; return; }
    const x = pts[i], chg = (x.c / first - 1) * 100;
    $("#ohlc").innerHTML = `<span dir="ltr">O ${nf(x.o)} H ${nf(x.h)} L ${nf(x.l)} C ${nf(x.c)}</span> <span class="${cls(chg)}">${pct(chg)}</span>`;
  });

  const rel = $("#rsiChart");
  const rc = makeChart("rsi", rel, { rightPriceScale: { borderColor: css("--line"), scaleMargins: { top: .1, bottom: .1 } },
    timeScale: { borderColor: css("--line"), visible: false }, handleScroll: false, handleScale: false });
  if (!rc) return;
  const rs = rc.addLineSeries({ color: css("--s3"), lineWidth: 2, priceLineVisible: false });
  const rv = rsiA(closes);
  rs.setData(pts.map((p, i) => ({ time: p.time, value: rv[i] })).filter((x) => x.value != null));
  rs.createPriceLine({ price: 70, color: css("--bear"), lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
  rs.createPriceLine({ price: 30, color: css("--bull"), lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
  rc.timeScale().fitContent();
  c.timeScale().subscribeVisibleLogicalRangeChange((r) => r && rc.timeScale().setVisibleLogicalRange(r));
}

async function runBacktest(ticker) {
  const st = $("#btStrategy").value, yrs = $("#btYears").value;
  $("#btOut").innerHTML = `<div class="skeleton"></div>`;
  const r = await api(`/api/backtest?ticker=${encodeURIComponent(ticker)}&strategy=${st}&years=${yrs}`);
  if (r.error) { $("#btOut").innerHTML = `<div class="warn-row">${esc(r.error)}</div>`; return; }
  const s = r.stats;
  const beat = s.total_return_pct > s.buy_hold_pct;
  $("#btOut").innerHTML = `
    <div class="metrics">
      <div class="metric"><div class="ml">תשואת אסטרטגיה</div><div class="mv ${cls(s.total_return_pct)}">${pct(s.total_return_pct, 1)}</div></div>
      <div class="metric"><div class="ml">קנה והחזק</div><div class="mv ${cls(s.buy_hold_pct)}">${pct(s.buy_hold_pct, 1)}</div></div>
      <div class="metric"><div class="ml">ירידה מקסימלית</div><div class="mv down">${pct(s.max_dd_pct, 1)}</div></div>
      <div class="metric"><div class="ml">אחוז הצלחה</div><div class="mv">${s.win_rate_pct != null ? nf(s.win_rate_pct, 0) + "%" : "—"}</div></div>
      <div class="metric"><div class="ml">עסקאות</div><div class="mv">${s.trades}</div></div>
      <div class="metric"><div class="ml">Sharpe</div><div class="mv">${nf(s.sharpe, 2)}</div></div>
      <div class="metric"><div class="ml">Profit factor</div><div class="mv">${nf(s.profit_factor, 2)}</div></div>
      <div class="metric"><div class="ml">תשואה שנתית</div><div class="mv ${cls(s.cagr_pct)}">${pct(s.cagr_pct, 1)}</div></div>
    </div>
    <div class="chips" style="margin:10px 0"><span class="chip ${beat ? "bull" : "warn"}">${beat ? "✔ האסטרטגיה ניצחה את קנה-והחזק" : "✖ קנה-והחזק היה עדיף בתקופה הזו"}</span>
      <span class="chip">ירידה מקס׳ ${pct(s.max_dd_pct, 1)} מול ${pct(s.buy_hold_max_dd_pct, 1)}</span></div>
    <div class="chart-legend"><span><i style="background:${css("--s1")}"></i>אסטרטגיה</span><span><i style="background:${css("--neutral")}"></i>קנה והחזק</span></div>
    <div class="bt-chart" id="btChart"></div>`;
  const c = makeChart("bt", $("#btChart"));
  if (!c) return;
  const a = c.addLineSeries({ color: css("--s1"), lineWidth: 2, priceLineVisible: false });
  const b = c.addLineSeries({ color: css("--neutral"), lineWidth: 2, lineStyle: 0, priceLineVisible: false });
  a.setData(r.curve.t.map((t, i) => ({ time: t, value: r.curve.strategy[i] * 100 })));
  b.setData(r.curve.t.map((t, i) => ({ time: t, value: r.curve.buy_hold[i] * 100 })));
  a.setMarkers(r.trades.filter((t) => t.reason !== "open").flatMap((t) => [
    { time: t.entry_date, position: "belowBar", color: css("--bull"), shape: "arrowUp", text: "" },
    { time: t.exit_date, position: "aboveBar", color: t.ret_pct >= 0 ? css("--bull") : css("--bear"), shape: "arrowDown", text: "" },
  ]).filter((m) => r.curve.t.length && m.time >= r.curve.t[0]).sort((x, y) => x.time.localeCompare(y.time)));
  c.timeScale().fitContent();
}

function closeDrawer() {
  $("#drawer").hidden = true;
  document.body.style.overflow = "";
  ["price", "rsi", "bt"].forEach((k) => { try { state.charts[k]?.remove(); } catch (e) { /* noop */ } delete state.charts[k]; });
  history.replaceState(null, "", location.pathname);
}

/* ------------------------------------------------------------------ forms / modal */
function modal(title, html) {
  $("#mTitle").textContent = title;
  $("#mBody").innerHTML = html;
  $("#modal").hidden = false;
}
const closeModal = () => { $("#modal").hidden = true; };

function holdingForm(h = {}) {
  const editing = !!h.id;
  modal(editing ? `עריכת ${h.ticker}` : "פוזיציה חדשה", `
    <form class="form" id="hForm">
      <label>סימול<input type="text" name="ticker" required value="${esc(h.ticker || "")}" placeholder="NVDA / TEVA.TA" dir="ltr"></label>
      <label>סל<input type="text" name="basket" value="${esc(h.basket || "")}" placeholder="למשל: AI ושבבים" list="basketsDl"></label>
      <label>כמות<input type="number" step="any" name="shares" required value="${h.shares ?? ""}"></label>
      <label>מחיר ממוצע<input type="number" step="any" name="avg_price" required value="${h.avg_price != null ? +(+h.avg_price).toFixed(4) : ""}"></label>
      <label>סטופ לוס<input type="number" step="any" name="stop_loss" value="${h.stop_loss != null ? +(+h.stop_loss).toFixed(4) : ""}"></label>
      <label>יעד רווח<input type="number" step="any" name="take_profit" value="${h.take_profit != null ? +(+h.take_profit).toFixed(4) : ""}"></label>
      <label>סטופ נגרר %<input type="number" step="any" name="trailing_pct" value="${h.trailing_pct ?? ""}"></label>
      <label>תאריך כניסה<input type="date" name="opened_at" value="${esc(h.opened_at || new Date().toISOString().slice(0, 10))}"></label>
      <div class="hint full">מניות ת״א: סיומת .TA ומחיר בשקלים. ללא סטופ – יופעל סטופ ברירת מחדל לחישובי סיכון.</div>
      <div class="full row gap" style="justify-content:space-between">
        ${editing ? `<button type="button" class="btn danger" id="hDel">מחק</button>` : "<span></span>"}
        <button class="btn primary">${editing ? "שמור" : "הוסף לתיק"}</button>
      </div>
    </form>
    <datalist id="basketsDl">${[...new Set((state.d?.lots || []).map((l) => l.basket))].map((b) => `<option value="${esc(b)}">`).join("")}</datalist>`);
  $("#hForm").onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    const r = editing ? await api(`/api/holdings/${h.id}`, { method: "PUT", body }) : await api("/api/holdings", { method: "POST", body });
    if (r.error) return toast({ level: "warning", title: "שגיאה", body: r.error });
    closeModal(); closeDrawer();
    toast({ level: "opportunity", title: "נשמר", body: state.cloud ? "הנתונים יתעדכנו בסריקה שמתחילה עכשיו (כ-2 דקות)" : "סורק מחדש…" });
    setTimeout(load, 2500);
  };
  if (editing) $("#hDel").onclick = async () => {
    if (!confirm(`למחוק את ${h.ticker} מהתיק?`)) return;
    await api(`/api/holdings/${h.id}`, { method: "DELETE" });
    closeModal(); closeDrawer(); load();
  };
}

function watchForm() {
  modal("הוספה לרשימת מעקב", `
    <form class="form" id="wForm">
      <label>סימול<input type="text" name="ticker" required placeholder="AAPL / ESLT.TA" dir="ltr"></label>
      <label>סל<input type="text" name="basket" placeholder="מעקב"></label>
      <div class="full"><button class="btn primary">הוסף</button></div>
    </form>`);
  $("#wForm").onsubmit = async (e) => {
    e.preventDefault();
    const r = await api("/api/watchlist", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
    if (r.error) return toast({ level: "warning", title: "שגיאה", body: r.error });
    closeModal(); toast({ level: "opportunity", title: "נוסף למעקב", body: "יופיע אחרי הסריקה" }); setTimeout(load, 3000);
  };
}

function orderForm(s) {
  const sz = s.sizing || {};
  modal(`פקודה – ${s.ticker} (Paper)`, `
    <form class="form" id="oForm">
      <label>צד<select name="side"><option value="buy">קנייה</option><option value="sell">מכירה</option></select></label>
      <label>כמות<input type="number" name="qty" value="${s.holding ? s.holding.shares : sz.shares || 1}" min="1" required></label>
      <label>סטופ (Bracket)<input type="number" step="any" name="stop" value="${nf(sz.stop).replace(/,/g, "")}"></label>
      <label>יעד (Bracket)<input type="number" step="any" name="target" value="${nf(sz.target).replace(/,/g, "")}"></label>
      <label class="full"><span><input type="checkbox" name="confirm" required> אני מאשר שליחת פקודה לחשבון ה-Paper</span></label>
      <div class="full"><button class="btn primary">שלח פקודה</button></div>
    </form>`);
  $("#oForm").onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const r = await api("/api/broker/order", { method: "POST", body: { ticker: s.ticker, side: fd.side, qty: +fd.qty, stop: +fd.stop || null, target: +fd.target || null, confirm: true } });
    if (r.error) return toast({ level: "critical", title: "הפקודה נדחתה", body: r.error });
    closeModal(); toast({ level: "opportunity", title: "הפקודה נשלחה", body: `סטטוס: ${r.status}` });
  };
}

function settingsModal(tab = "risk") {
  const d = state.d, r = d.risk, f = d.features || {};
  const me = d.me;
  const tabs = { risk: "ניהול סיכונים", portfolio: "תיק ומעקב", notify: "התראות" };
  if (me) tabs.account = "החשבון שלי";
  if (me?.is_admin) tabs.users = "משתמשים";
  if (!me || me.is_admin) tabs.system = "מערכת";
  if (!tabs[tab]) tab = "risk";
  let body = "";
  if (tab === "account") {
    body = `<form class="form" id="meForm">
      <div class="full row gap">${avatar(me, 44)}<div><b>${esc(me.name)}</b><div class="muted small">${me.is_admin ? "מנהל" : "משתמש"}${me.google_email ? ` · 🔐 ${esc(me.google_email)}` : ""}</div></div></div>
      <label>שם תצוגה<input type="text" name="name" value="${esc(me.name)}" maxlength="30"></label>
      <label>מספר צ׳אט בטלגרם<input type="text" name="telegram_chat_id" value="${esc(me.telegram_chat_id)}" inputmode="numeric" dir="ltr" placeholder="למשל 123456789">
        <span class="hint">${f.telegram_bot ? "שלח /start לבוט של המערכת בטלגרם והדבק כאן את המספר שהוא מחזיר" : "הבוט עוד לא הוגדר – בקש מהמנהל"}</span></label>
      <div class="full"><button class="btn primary">שמור</button></div>
    </form>
    <form class="form" id="llmForm">
      <div class="full"><b>🤖 מפתחות AI אישיים</b>
        <div class="hint" id="llmStatus">${aiStatusText(d.llm)}</div>${aiErrorsText(d.llm)}
        <div class="hint">עם מפתח משלך הניתוח רץ על המכסה החינמית שלך, בלי הגבלה יומית מהמערכת. בלי מפתח – משתמשים במפתח המשותף עד המכסה היומית שלך, ואחריה בניתוח מבוסס חוקים.</div></div>
      <label>Gemini <a class="hint" href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">קבל מפתח חינמי ↗</a>
        <input type="password" name="gemini" autocomplete="off" dir="ltr" placeholder="טוען…"></label>
      <label>Groq <a class="hint" href="https://console.groq.com/keys" target="_blank" rel="noopener">קבל מפתח חינמי ↗</a>
        <input type="password" name="groq" autocomplete="off" dir="ltr" placeholder="טוען…"></label>
      <label class="full">OpenRouter (רשות) <a class="hint" href="https://openrouter.ai/keys" target="_blank" rel="noopener">קבל מפתח ↗</a>
        <input type="password" name="openrouter" autocomplete="off" dir="ltr" placeholder="טוען…"></label>
      <div class="full hint">כדי שהמפתח יישאר חינמי: אל תפעיל חיוב (Billing) בחשבון שבו יצרת אותו. בלי חיוב, הספק פשוט עוצר כשמגיעים למכסה ולא גובה כסף.</div>
      <div class="full row gap" style="justify-content:space-between"><button type="button" class="btn small" id="llmClear">הסר את המפתחות שלי</button><button class="btn primary">שמור ובדוק</button></div>
    </form>
    <form class="form" id="pwForm">
      <div class="full"><b>שינוי סיסמה</b></div>
      <label>סיסמה נוכחית<input type="password" name="current_password" autocomplete="current-password" required></label>
      <label>סיסמה חדשה<input type="password" name="new_password" autocomplete="new-password" minlength="4" required></label>
      <div class="full row gap" style="justify-content:space-between"><button type="button" class="btn danger" id="logoutBtn">התנתק</button><button class="btn primary">עדכן סיסמה</button></div>
    </form>`;
  } else if (tab === "users") {
    body = `<div class="list-edit" id="usersList"><div class="skeleton"></div></div>
      <form class="form" id="newUser">
        <div class="full"><b>הוספת משתמש</b><div class="hint">כל משתמש מקבל תיק, התראות ודשבורד משלו. הוא נכנס עם השם והסיסמה שתגדיר כאן.</div></div>
        <div class="full hint" id="gHint"></div>
        <label>שם<input type="text" name="name" maxlength="30" required></label>
        <label id="gEmailNew" hidden>מייל Google (רשות)<input type="email" name="google_email" dir="ltr" placeholder="name@gmail.com"></label>
        <label class="full">סיסמה ראשונית<input type="text" name="password" minlength="4" placeholder="לא חובה אם הוזן מייל Google"></label>
        <div class="full"><button class="btn primary">הוסף משתמש</button></div>
      </form>`;
  } else if (tab === "risk") {
    const fld = (k, l, hint) => `<label>${l}<input type="number" step="any" name="${k}" value="${r[k]}"><span class="hint">${hint}</span></label>`;
    body = `<form class="form" id="rForm">
      ${fld("cash", `מזומן פנוי (${d.portfolio?.base || "USD"})`, "משמש לחישוב גודל פוזיציה")}
      ${fld("risk_per_trade_pct", "סיכון לעסקה %", "הפסד מקס׳ אם הסטופ נפגע")}
      ${fld("max_position_pct", "משקל מקס׳ למניה %", "")}
      ${fld("max_basket_pct", "משקל מקס׳ לסל %", "")}
      ${fld("default_stop_pct", "סטופ ברירת מחדל %", "למניות בלי סטופ")}
      ${fld("atr_stop_mult", "סטופ מוצע ×ATR", "מרחק הסטופ בתנודתיות")}
      ${fld("reward_risk", "יחס סיכוי:סיכון", "יעד = כניסה + יחס × סיכון")}
      <div class="full"><button class="btn primary">שמור</button></div></form>`;
  } else if (tab === "portfolio") {
    body = `<div class="list-edit"><div class="row gap" style="justify-content:space-between"><b>פוזיציות</b><button class="btn small" id="sAddH">＋ פוזיציה</button></div>
      ${d.lots.map((l) => `<div class="le-row"><span><span class="tk">${esc(l.ticker)}</span> ${nf(l.shares, 0)} × ${nf(l.avg_price)} <span class="muted small">${esc(l.basket)}</span></span>
        <button class="btn small" data-e="${l.id}">✏️</button><button class="btn small danger" data-d="${l.id}">🗑</button></div>`).join("")}
      <div class="row gap" style="justify-content:space-between;margin-top:12px"><b>רשימת מעקב</b><button class="btn small" id="sAddW">＋ מעקב</button></div>
      ${d.watchlist.map((w) => `<div class="le-row"><span><span class="tk">${esc(w.ticker)}</span> <span class="muted small">${esc(w.basket)}</span></span><span></span>
        <button class="btn small danger" data-dw="${esc(w.ticker)}">🗑</button></div>`).join("")}</div>`;
  } else if (tab === "notify") {
    const perm = "Notification" in window ? Notification.permission : "unsupported";
    body = `<div class="list-edit">
      <div class="feat"><span>📱 טלגרם ${f.telegram ? "" : `<div class='hint muted small'>${me ? "הכנס את מספר הצ׳אט שלך בלשונית ׳החשבון שלי׳" : "הגדר TELEGRAM_BOT_TOKEN ו-TELEGRAM_CHAT_ID בקובץ .env"}</div>`}</span><span class="${f.telegram ? "on-dot" : "off-dot"}">${f.telegram ? "● פעיל" : "○ כבוי"}</span></div>
      <div class="feat"><span>🔔 התראות דפדפן/טלפון (Push) ${f.webpush ? "" : "<div class='hint muted small'>דורש VAPID keys ו-HTTPS – ראה README</div>"}</span>
        <button class="btn small" id="sPush" ${f.webpush || perm !== "granted" ? "" : ""}>${perm === "granted" ? "הירשם מחדש" : "הפעל"}</button></div>
      <div class="feat"><span>🖥️ התראות בתוך הדשבורד (חי)</span><span class="on-dot">● פעיל</span></div>
      <button class="btn primary" id="sTest" style="margin-top:8px">שלח התראת בדיקה</button></div>`;
  } else {
    const row = (l, on, hint = "") => `<div class="feat"><span>${l}${hint ? `<div class="hint muted small">${hint}</div>` : ""}</span><span class="${on ? "on-dot" : "off-dot"}">${on ? "● פעיל" : "○ כבוי"}</span></div>`;
    body = `<div class="list-edit">
      ${row("🤖 מודל שפה חינמי", f.llm, f.llm ? `סדר: ${f.llm_providers.join(" → ")}` : "ללא מפתח – ניתוח מבוסס חוקים. הוסף GEMINI_API_KEY או GROQ_API_KEY")}
      ${row("📈 מצב נתוני אמת", !d.demo, d.demo ? "DEMO_MODE=1 – נתונים סינתטיים" : "Yahoo Finance + RSS + StockTwits")}
      ${row("📤 ברוקר Alpaca (Paper)", f.broker, "אופציונלי – פקודות רק באישור ידני")}
      <div class="feat"><span>⏱️ תדירות סריקה</span><span class="num">${state.cloud ? "30 (שעתיים בלילה)" : d.status?.interval_min ?? "—"} ד׳</span></div>
      <div class="feat"><span>🔢 סריקות</span><span class="num">${d.status?.scans ?? 0}</span></div>
      ${d.llm ? `<div class="feat"><span>🤖 AI בחשבון שלך<div class="hint muted small">${aiStatusText(d.llm)}${d.llm.last_ok ? ` · עובד דרך ${esc(d.llm.last_ok.split(":")[0])}` : ""}</div>${aiErrorsText(d.llm)}</span><span></span></div>` : ""}
      ${me?.is_admin ? `<div class="feat" id="sharedUsage"><span>🔑 מפתח משותף – שימוש היום</span><span class="num">…</span></div>` : ""}
      <div id="shabbatBox"></div>
      <button class="btn" id="sLLM" style="margin-top:8px">🤖 סריקה + ניתוח AI מלא עכשיו</button></div>`;
  }
  modal("הגדרות", `<div class="tabs">${Object.entries(tabs).map(([k, v]) => `<button data-tab="${k}" class="${k === tab ? "on" : ""}">${v}</button>`).join("")}</div>${body}`);
  $$("[data-tab]").forEach((b) => b.onclick = () => settingsModal(b.dataset.tab));
  if (tab === "risk") $("#rForm").onsubmit = async (e) => {
    e.preventDefault();
    await api("/api/risk", { method: "PUT", body: Object.fromEntries(new FormData(e.target)) });
    toast({ level: "opportunity", title: "נשמר", body: "מגבלות הסיכון עודכנו" });
    await api("/api/scan", { method: "POST" }); setTimeout(load, 2500); closeModal();
  };
  if (tab === "portfolio") {
    $("#sAddH").onclick = () => holdingForm();
    $("#sAddW").onclick = () => watchForm();
    $$("[data-e]").forEach((b) => b.onclick = () => holdingForm(d.lots.find((l) => l.id === +b.dataset.e)));
    $$("[data-d]").forEach((b) => b.onclick = async () => { if (confirm("למחוק?")) { await api(`/api/holdings/${b.dataset.d}`, { method: "DELETE" }); await load(); settingsModal("portfolio"); } });
    $$("[data-dw]").forEach((b) => b.onclick = async () => { await api(`/api/watchlist/${encodeURIComponent(b.dataset.dw)}`, { method: "DELETE" }); await load(); settingsModal("portfolio"); });
  }
  if (tab === "notify") {
    $("#sPush").onclick = enablePush;
    $("#sTest").onclick = async () => { const r = await api("/api/notify/test", { method: "POST" }); if (r.ok) toast({ level: "info", title: "נשלח", body: `טלגרם: ${r.telegram ? "✔" : "כבוי"} · Push: ${r.webpush ? "✔" : "כבוי"}` }); };
  }
  if (tab === "account") {
    $("#meForm").onsubmit = async (e) => {
      e.preventDefault();
      const r = await api("/api/me", { method: "PUT", body: Object.fromEntries(new FormData(e.target)) });
      if (r.error) return toast({ level: "warning", title: "שגיאה", body: r.error });
      state.d.me = r; renderMe(r); toast({ level: "opportunity", title: "נשמר", body: r.telegram_chat_id ? "התראות התיק שלך יגיעו לטלגרם" : "" });
      settingsModal("account");
    };
    $("#pwForm").onsubmit = async (e) => {
      e.preventDefault();
      const r = await api("/api/me", { method: "PUT", body: Object.fromEntries(new FormData(e.target)) });
      if (r.error) return toast({ level: "warning", title: "שגיאה", body: r.error });
      e.target.reset(); toast({ level: "opportunity", title: "הסיסמה עודכנה" });
    };
    $("#logoutBtn").onclick = logout;
    const fillKeys = (keys) => ["gemini", "groq", "openrouter"].forEach((p) => {
      const inp = $(`#llmForm [name=${p}]`); inp.value = ""; inp.placeholder = keys[p] ? `שמור: ${keys[p]}` : "לא הוגדר";
    });
    api("/api/me/llm").then((r) => { if (!r.error) fillKeys(r.keys || {}); });
    $("#llmForm").onsubmit = async (e) => {
      e.preventDefault();
      const body = {};
      for (const [k, v] of new FormData(e.target)) if (v.trim()) body[k] = v.trim();
      if (!Object.keys(body).length) return toast({ level: "info", title: "לא הוכנס מפתח חדש" });
      const btn = $("#llmForm .btn.primary"); btn.disabled = true; btn.textContent = "בודק…";
      const r = await api("/api/me/llm", { method: "PUT", body });
      btn.disabled = false; btn.textContent = "שמור ובדוק";
      if (r.error) return toast({ level: "warning", title: "המפתח לא נשמר", body: r.error });
      fillKeys(r.keys);
      toast({ level: "opportunity", title: "המפתח נבדק ונשמר ✔", body: "מהסריקה הבאה הניתוח שלך ירוץ על המפתח שלך" });
    };
    $("#llmClear").onclick = async () => {
      const r = await api("/api/me/llm", { method: "PUT", body: { gemini: "", groq: "", openrouter: "" } });
      if (!r.error) { fillKeys(r.keys); toast({ level: "info", title: "המפתחות הוסרו", body: "חוזרים למפתח המשותף" }); }
    };
  }
  if (tab === "users") {
    const drawUsers = async () => {
      const res = await api("/api/users");
      if (res.error) { $("#usersList").innerHTML = `<div class="warn-row">${esc(res.error)}</div>`; return; }
      const list = Array.isArray(res) ? res : res.users;
      const gOn = !!res.google_enabled;
      $("#gEmailNew").hidden = false;
      $("#gHint").innerHTML = gOn ? "✅ כניסה עם Google פעילה. משתמש עם מייל Google נכנס רק דרך Google; בלי מייל – עם סיסמה."
        : "ℹ️ כניסה עם Google עוד לא הוגדרה (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). אפשר כבר לשמור מיילים – הם יופעלו כשתגדיר.";
      $("#usersList").innerHTML = list.map((u) => `<div class="le-row user-row">
        <span class="row gap">${avatar(u, 30)}<span><b>${esc(u.name)}</b>${u.is_admin ? ` <span class="chip">מנהל</span>` : ""}
          <div class="muted small">${u.google_email ? `🔐 ${esc(u.google_email)}` : "🔑 סיסמה"} · ${u.telegram_chat_id ? "📱 טלגרם" : "ללא טלגרם"}</div></span></span>
        <button class="btn small" data-ge="${esc(u.id)}" data-cur="${esc(u.google_email)}">✉️ Google</button>
        ${u.is_admin ? `<span></span><span></span>` : `<button class="btn small" data-rp="${esc(u.id)}">🔑 סיסמה</button><button class="btn small danger" data-du="${esc(u.id)}" data-name="${esc(u.name)}">🗑</button>`}</div>`).join("");
      $$("[data-ge]").forEach((b) => b.onclick = () => {
        const row = b.closest(".le-row");
        if ($(".inline-pw", row.parentElement) && row.nextElementSibling?.classList.contains("inline-pw")) return;
        row.insertAdjacentHTML("afterend", `<form class="inline-pw le-row"><input type="email" dir="ltr" placeholder="name@gmail.com (ריק = הסר)" value="${esc(b.dataset.cur)}"><button class="btn small primary">שמור</button><span></span></form>`);
        const form = row.nextElementSibling;
        $("input", form).focus();
        form.onsubmit = async (e) => {
          e.preventDefault();
          const r = await api(`/api/users/${b.dataset.ge}`, { method: "PUT", body: { google_email: $("input", form).value } });
          toast(r.error ? { level: "warning", title: "שגיאה", body: r.error } : { level: "opportunity", title: "נשמר", body: r.google_email ? `${r.name} ייכנס עם ${r.google_email}` : `${r.name} ייכנס עם סיסמה` });
          drawUsers();
        };
      });
      $$("[data-rp]").forEach((b) => b.onclick = () => {
        const row = b.closest(".le-row");
        if ($(".inline-pw", row)) return;
        row.insertAdjacentHTML("afterend", `<form class="inline-pw le-row"><input type="text" placeholder="סיסמה חדשה" minlength="4" required><button class="btn small primary">שמור</button><span></span></form>`);
        const form = row.nextElementSibling;
        $("input", form).focus();
        form.onsubmit = async (e) => {
          e.preventDefault();
          const r = await api(`/api/users/${b.dataset.rp}`, { method: "PUT", body: { password: $("input", form).value } });
          toast(r.error ? { level: "warning", title: "שגיאה", body: r.error } : { level: "opportunity", title: "הסיסמה עודכנה", body: "שלח למשתמש את הסיסמה החדשה" });
          form.remove();
        };
      });
      $$("[data-du]").forEach((b) => b.onclick = async () => {
        if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "למחוק?"; setTimeout(() => { b.dataset.armed = ""; b.textContent = "🗑"; }, 4000); return; }
        const r = await api(`/api/users/${b.dataset.du}`, { method: "DELETE" });
        toast(r.error ? { level: "warning", title: "שגיאה", body: r.error } : { level: "info", title: `${b.dataset.name} נמחק` });
        drawUsers();
      });
    };
    drawUsers();
    $("#newUser").onsubmit = async (e) => {
      e.preventDefault();
      const r = await api("/api/users", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
      if (r.error) return toast({ level: "warning", title: "שגיאה", body: r.error });
      toast({ level: "opportunity", title: `${r.name} נוסף`, body: "שלח לו את הכתובת והסיסמה. בכניסה הראשונה הוא יבנה את התיק שלו." });
      e.target.reset(); drawUsers();
    };
  }
  if (tab === "system" && state.cloud) drawShabbat(me?.is_admin);
  if (tab === "system" && me?.is_admin) api("/api/llm/usage").then((u) => {
    const el = $("#sharedUsage .num"); if (el && !u.error) el.textContent = `${u.total || 0} בקשות`;
  });
  if (tab === "system") $("#sLLM").onclick = async () => { await api("/api/scan?llm=1", { method: "POST" }); closeModal(); toast({ level: "info", title: "סריקה מלאה התחילה", body: "התוצאות יתעדכנו אוטומטית" }); };
}

async function drawShabbat(isAdmin) {
  const box = $("#shabbatBox");
  if (!box) return;
  const r = await api("/api/shabbat");
  if (r.error) return;
  const fmt = (ms) => new Date(ms).toLocaleString("he-IL", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  box.innerHTML = `<div class="feat shabbat-feat"><span>🕯️ שבתות וחגים – בלי התראות וסריקות
      <div class="hint muted small">מהדלקת נרות ועד צאת השבת/החג, לפי לוח השנה העברי (Hebcal, מנהג ארץ ישראל). במוצאי שבת/חג נשלח סיכום המלצות.</div></span>
      ${isAdmin ? `<label class="switch"><input type="checkbox" id="shOn" ${r.enabled ? "checked" : ""}><span></span></label>` : `<span class="${r.enabled ? "on-dot" : "off-dot"}">${r.enabled ? "● פעיל" : "○ כבוי"}</span>`}</div>
    ${isAdmin ? `<div class="feat"><span>📍 זמני כניסה ויציאה לפי</span><select id="shCity">${Object.entries(r.cities || {}).map(([id, n]) => `<option value="${id}" ${id === r.geonameid ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></div>` : ""}
    ${(r.windows || []).length ? `<div class="sh-list">${r.windows.slice(0, 4).map((w) => `<div class="sh-row ${r.current && r.current.end === w.end ? "now" : ""}"><b>${esc(w.title)}</b><span class="muted small">${fmt(w.candles || w.start)} ← ${fmt(w.havdalah || w.end)}</span></div>`).join("")}</div>` : ""}`;
  if (isAdmin) {
    const save = async (body) => { const x = await api("/api/shabbat", { method: "PUT", body }); if (!x.error) { toast({ level: "opportunity", title: "נשמר" }); drawShabbat(true); load(); } };
    $("#shOn").onchange = (e) => save({ enabled: e.target.checked });
    $("#shCity").onchange = (e) => save({ geonameid: e.target.value });
  }
}

/* ------------------------------------------------------------------ notifications */
function toast(a) {
  const el = document.createElement("div");
  el.className = `toast lv-${a.level || "info"}`;
  el.innerHTML = `<div class="t">${LEVEL[a.level]?.ico || ""} ${a.ticker ? `<span class="tk">${esc(a.ticker)}</span> ` : ""}${esc(a.title)}</div><div class="b">${esc(a.body || "")}</div>`;
  el.onclick = () => { el.remove(); if (a.ticker) openStock(a.ticker); };
  $("#toasts").prepend(el);
  setTimeout(() => el.remove(), 9000);
}

function browserNotify(a) {
  if (!("Notification" in window) || Notification.permission !== "granted" || !document.hidden) return;
  try {
    const n = new Notification(`${LEVEL[a.level]?.ico || ""} ${a.ticker ? a.ticker + " · " : ""}${a.title}`, { body: a.body, tag: `${a.ticker}-${a.kind}`, icon: "/static/icon-192.png" });
    n.onclick = () => { window.focus(); if (a.ticker) openStock(a.ticker); };
  } catch (e) { /* mobile browsers require the service worker path */ }
}

async function enablePush() {
  if (!("Notification" in window)) return toast({ level: "warning", title: "לא נתמך", body: "הדפדפן לא תומך בהתראות. בטלפון: הוסף את האתר למסך הבית." });
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return toast({ level: "warning", title: "ההרשאה נדחתה", body: "אפשר לשנות בהגדרות האתר בדפדפן" });
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    const { publicKey } = await api("/api/push/key");
    if (!publicKey) return toast({ level: "info", title: "התראות דפדפן פעילות", body: "יוצגו כשהדשבורד פתוח. ל-Push גם כשהוא סגור – הגדר VAPID בשרת." });
    const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((publicKey.length + 3) % 4)), (c) => c.charCodeAt(0));
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api("/api/push/subscribe", { method: "POST", body: sub.toJSON() });
    toast({ level: "opportunity", title: "Push הופעל", body: "תקבל התראות גם כשהדשבורד סגור" });
  } catch (e) { toast({ level: "warning", title: "Push נכשל", body: String(e.message || e) }); }
}

let reloadTimer = null;
const reloadSoon = (ms = 800) => { clearTimeout(reloadTimer); reloadTimer = setTimeout(load, ms); };

function connectStream() {
  if (STATIC || !window.EventSource) return;
  const es = new EventSource("/api/stream");
  state.es = es;
  es.addEventListener("alert", (e) => {
    const a = JSON.parse(e.data);
    if (state.d) { state.d.alerts.unshift(a); state.d.unread++; renderAlerts(); $("#unread").hidden = false; $("#unread").textContent = state.d.unread; }
    const li = $("#alertList .alert"); if (li) li.classList.add("new");
    toast(a); browserNotify(a);
  });
  es.addEventListener("scan", (e) => { renderStatus(JSON.parse(e.data)); reloadSoon(); });
  es.addEventListener("status", (e) => renderStatus(JSON.parse(e.data)));
  es.addEventListener("brief", () => reloadSoon());
  es.onerror = () => { /* EventSource reconnects automatically */ };
}

/* ------------------------------------------------------------------ events */
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-ticker]");
  if (t && t.dataset.ticker && !e.target.closest("a, button")) openStock(t.dataset.ticker);
  if (e.target.closest("[data-close]")) closeDrawer();
  if (e.target.closest("[data-mclose]")) closeModal();
  const bf = e.target.closest("#basketFilter button"); if (bf) { state.basket = bf.dataset.b; renderBasketFilter(); renderHoldings(); }
  const af = e.target.closest("#alertFilter button"); if (af) { state.alertFilter = af.dataset.f; $$("#alertFilter button").forEach((b) => b.classList.toggle("on", b === af)); renderAlerts(); }
  const nf2 = e.target.closest("#newsFilter button"); if (nf2) { state.newsFilter = nf2.dataset.f; $$("#newsFilter button").forEach((b) => b.classList.toggle("on", b === nf2)); renderNews(); }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); closeDrawer(); } });
$("#btnScan").onclick = async () => {
  $("#btnScan").classList.add("busy");
  const r = await api("/api/scan", { method: "POST" });
  if (r.status === "busy") toast({ level: "info", title: "סריקה כבר רצה" });
  else if (r.error) toast({ level: "warning", title: "לא ניתן להפעיל סריקה", body: r.error });
  else if (state.cloud) toast({ level: "info", title: "הסריקה התחילה", body: "התוצאות יופיעו כאן בעוד כ-2 דקות" });
  if (state.cloud) setTimeout(() => $("#btnScan").classList.remove("busy"), 120000);
};
$("#btnSettings").onclick = () => state.d && settingsModal();
document.addEventListener("click", (e) => {
  const v = e.target.closest(".view-seg [data-view]");
  if (!v) return;
  state.view = v.dataset.view;
  try { localStorage.setItem(VIEW_KEY, state.view); } catch (err) { /* private mode */ }
  $$(".view-seg [data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === state.view));
  renderHoldings(); renderOpps();
});
setInterval(fetchQuotes, 60 * 1000);
document.querySelectorAll(".view-slot").forEach((el) => { el.innerHTML = viewToggleHTML(); });

$("#digestNow").onclick = async () => {
  const r = await api("/api/scan?digest=1", { method: "POST" });
  toast(r.error ? { level: "warning", title: "לא ניתן לשלוח עכשיו", body: r.error }
    : r.status === "busy" ? { level: "info", title: "סריקה כבר רצה", body: "נסה שוב בעוד דקה" }
    : { level: "opportunity", title: "מכין סיכום המלצות", body: "יגיע לטלגרם ויופיע כאן בעוד כ‑2–3 דקות" });
};
// refresh as soon as the app comes back to the foreground (phones pause timers in the background)
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.cloud && !loginShown) load(); });
window.addEventListener("focus", () => { if (state.cloud && !loginShown && Date.now() - (state.lastLoad || 0) > 20000) load(); });

$("#searchForm").onsubmit = (e) => {
  e.preventDefault();
  const t = $("#searchInput").value.trim();
  if (!t) return;
  $("#searchInput").blur();
  openStock(t);
};
$("#btnMe").onclick = () => state.d && settingsModal("account");
$("#btnAddHolding").onclick = () => holdingForm();
$("#btnAddWatch").onclick = () => watchForm();
$("#btnBell").onclick = async () => {
  document.querySelector(".alerts-card").scrollIntoView({ behavior: "smooth", block: "center" });
  if (state.d?.unread) { await api("/api/alerts/read", { method: "POST" }); state.d.unread = 0; $("#unread").hidden = true; }
  if ("Notification" in window && Notification.permission === "default") enablePush();
};

(async function init() {
  if ("serviceWorker" in navigator && !STATIC) navigator.serviceWorker.register("/sw.js").catch(() => {});
  await load();
  if (state.cloud) { if (!state.poll) state.poll = setInterval(load, 60 * 1000); } else if (state.d) connectStream();
  setInterval(() => state.d && renderStatus(state.d.status), 30000);
  if (!STATIC && !state.cloud) setInterval(load, 5 * 60 * 1000);
  const t = new URLSearchParams(location.search).get("ticker");
  if (t) openStock(t);
})();
