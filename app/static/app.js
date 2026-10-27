/* Trading Radar – dashboard front-end (vanilla JS, no build step). */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const STATIC = window.__SNAPSHOT__ || null; // static demo mode (no server)
const state = { d: null, basket: "all", alertFilter: "all", newsFilter: "all", charts: {}, es: null };

const ACTION_HE = { BUY: "קנייה", ADD: "הגדלה", HOLD: "החזקה", WATCH: "מעקב", TRIM: "מימוש חלקי", SELL: "מכירה" };
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
}

function render() {
  const d = state.d;
  $("#demoBanner").hidden = !d.demo;
  renderStatus(d.status);
  renderKPIs(d);
  renderBrief(d.brief, d.indices);
  renderAlerts();
  renderBasketFilter();
  renderHoldings();
  renderAlloc(d.portfolio);
  renderEquity(d);
  renderOpps();
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
    $("#scanInfo").textContent = `עודכן ${ago(s.last_scan)} (${last})` + (s.last_error ? " · ⚠ שגיאה" : "");
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

function renderHoldings() {
  const list = state.d.holdings.filter((h) => state.basket === "all" || h.basket === state.basket)
    .sort((a, b) => (b.position?.value || 0) - (a.position?.value || 0));
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

/* ------------------------------------------------------------------ login (multi-user cloud mode) */
const AVATAR = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9", "#e66767", "#008300"];
const avatar = (u, size = 34) => `<span class="avatar" style="--av:${AVATAR[(u.color ?? 0) % 8]};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px">${esc((u.name || "?").trim().charAt(0))}</span>`;
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } };

let loginShown = false;
async function showLogin() {
  if (loginShown) return;
  loginShown = true;
  const users = await fetch("/api/users/public").then((r) => r.json()).catch(() => []);
  let sel = users.find((u) => u.id === lsGet("radar_uid"))?.id || users[0]?.id;
  const el = document.createElement("div");
  el.className = "login";
  el.id = "login";
  const draw = () => {
    el.innerHTML = `<form class="login-card" id="loginForm">
      <div class="brand" style="justify-content:center"><svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" stroke-width="2" opacity=".35"/><circle cx="16" cy="16" r="8" fill="none" stroke="currentColor" stroke-width="2" opacity=".6"/><path d="M16 16 L27 9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><circle cx="23" cy="11" r="2.4" fill="var(--bull)"/></svg><div class="brand-name">רדאר מסחר</div></div>
      <div class="login-q">מי נכנס?</div>
      <div class="login-tabs" role="tablist">${users.map((u) => `<button type="button" role="tab" aria-selected="${u.id === sel}" class="login-tab ${u.id === sel ? "on" : ""}" data-uid="${esc(u.id)}">${avatar(u, 44)}<span>${esc(u.name)}</span></button>`).join("")}</div>
      <label class="login-pw">סיסמה<input type="password" id="loginPw" autocomplete="current-password" required></label>
      <div class="login-err" id="loginErr" role="alert"></div>
      <button class="btn primary" id="loginBtn">כניסה</button>
    </form>`;
    $$(".login-tab", el).forEach((b) => b.onclick = () => { sel = b.dataset.uid; draw(); $("#loginPw").focus(); });
    $("#loginForm", el).onsubmit = async (e) => {
      e.preventDefault();
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
  const s = await api(`/api/stock/${encodeURIComponent(ticker)}`);
  if (!s || s.error) { toast({ level: "warning", title: ticker, body: "המניה עוד לא נסרקה" }); return; }
  const ind = s.ind, a = s.analysis || {}, ccy = s.currency;
  $("#dTicker").textContent = s.ticker;
  $("#dName").textContent = `${s.name || ""} · ${s.basket || ""}`;
  $("#dPrice").innerHTML = `${sym(ccy)}${nf(ind.price)} <div class="${cls(ind.change_pct)}" style="font-size:14px">${pct(ind.change_pct)}</div>`;
  const h = s.holding, pos = s.position, sz = s.sizing || {};
  const lots = state.d?.lots?.filter((l) => l.ticker === s.ticker) || [];
  const f = s.fundamentals || {};
  const fm = [["מכפיל רווח", f.pe, 1], ["מכפיל עתידי", f.forward_pe, 1], ["צמיחת הכנסות", f.revenue_growth != null ? f.revenue_growth * 100 : null, 1, "%"],
    ["שולי רווח", f.profit_margin != null ? f.profit_margin * 100 : null, 1, "%"], ["יעד אנליסטים", f.target_mean, 2], ["המלצה", f.recommendation],
    ["בטא", f.beta, 2], ["דוחות הבאים", f.next_earnings], ["שווי שוק", f.market_cap ? f.market_cap / 1e9 : null, 1, "B"]].filter((x) => x[1] != null);

  $("#dBody").innerHTML = `
    <div class="panel ai-box">
      <div class="ai-head"><h3>🤖 ניתוח ${a.provider && a.provider !== "rules" ? `<span class="chip ai">${esc(a.provider)}</span>` : `<span class="chip">חוקים</span>`}</h3>
        <div class="row gap"><span class="action act-${s.action}">${ACTION_HE[s.action] || s.action}</span>
          <div class="conf">ביטחון <div class="conf-track"><div style="width:${a.confidence || 0}%"></div></div><span class="num">${a.confidence || 0}%</span></div></div></div>
      <p style="margin:10px 0 4px;font-weight:600">${esc(a.headline || "")}</p>
      <p style="margin:0 0 10px;color:var(--text-2)">${esc(a.summary || "")}</p>
      <div class="two-col"><div><div class="small muted">בעד</div><ul class="pros">${(a.bull || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>—</li>"}</ul></div>
        <div><div class="small muted">סיכונים</div><ul class="cons">${(a.bear || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>—</li>"}</ul></div></div>
      <div class="muted small" style="margin-top:8px">עודכן ${ago(s.analysis_ts)} · ציון טכני ${signed(s.tech_score)} · סנטימנט חדשות ${signed((s.news_sentiment || 0) * 100)}</div>
    </div>

    <div class="panel">
      <div class="chart-legend"><span><i style="background:${css("--s1")}"></i>רצועות בולינגר (20,2)</span><span><i style="background:${css("--s4")}"></i>ממוצע 50</span><span><i style="background:${css("--s6")}"></i>ממוצע 200</span><span id="ohlc" class="num"></span></div>
      <div class="price-chart" id="priceChart"></div>
      <div class="chart-legend" style="margin-top:6px"><span><i style="background:${css("--s3")}"></i>RSI (14)</span><span class="muted">קווים מקווקווים: 30 / 70</span></div>
      <div class="rsi-chart" id="rsiChart"></div>
    </div>

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
        ${state.d?.features?.broker && !s.ticker.endsWith(".TA") ? `<button class="btn small" data-order="${esc(s.ticker)}">📤 שלח פקודה (Paper)</button>` : ""}
      </div>
    </div>

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

    <div class="panel"><h3>📰 חדשות ורשתות</h3>
      <ul class="news-list">${(s.news_items || []).map((n) => `<li class="news-item"><div class="sent" style="background:${n.sentiment > .15 ? css("--bull") : n.sentiment < -.15 ? css("--bear") : css("--line-2")}"></div>
        <div><a class="nt" href="${esc(n.url)}" target="_blank" rel="noopener" style="color:inherit">${esc(n.title)}</a><div class="nm"><span>${esc(n.source)}</span><span>${ago(n.ts)}</span></div></div></li>`).join("") || `<div class="empty">אין חדשות</div>`}</ul>
    </div>
    ${s.congress?.length ? `<div class="panel"><h3>🏛️ עסקאות קונגרס</h3><ul class="congress">${s.congress.map((c) => `<li><span>${/purchase|buy/i.test(c.type) ? "🟢" : "🔴"}</span><div><b>${esc(c.member)}</b> <span class="muted">${esc(c.party)}</span><div class="muted small">${esc(c.amount)}</div></div><span class="small muted">${esc(c.date)}</span></li>`).join("")}</ul></div>` : ""}
  `;
  $("#drawer").hidden = false;
  document.body.style.overflow = "hidden";
  drawPriceChart(s);
  $("#btRun").onclick = () => runBacktest(s.ticker);
  $$("[data-edit-lot]").forEach((b) => b.onclick = () => holdingForm(state.d.lots.find((l) => l.id === +b.dataset.editLot)));
  $$("[data-add-from]").forEach((b) => b.onclick = () => holdingForm({ ticker: b.dataset.addFrom, avg_price: sz.entry, stop_loss: sz.stop, take_profit: sz.target, shares: sz.shares, basket: s.basket }));
  $$("[data-order]").forEach((b) => b.onclick = () => orderForm(s));
  history.replaceState(null, "", `?ticker=${encodeURIComponent(s.ticker)}`);
}

function drawPriceChart(s) {
  const ch = s.chart;
  const el = $("#priceChart"), rel = $("#rsiChart");
  const c = makeChart("price", el);
  if (!c) return;
  const candles = ch.t.map((t, i) => ({ time: t, open: ch.o[i], high: ch.h[i], low: ch.l[i], close: ch.c[i] })).filter((x) => x.close != null);
  const cs = c.addCandlestickSeries({ upColor: css("--bull"), downColor: css("--bear"), borderVisible: false, wickUpColor: css("--bull"), wickDownColor: css("--bear") });
  cs.setData(candles);
  const line = (vals, color, opts = {}) => {
    const sr = c.addLineSeries(Object.assign({ color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, opts));
    sr.setData(ch.t.map((t, i) => ({ time: t, value: vals[i] })).filter((x) => x.value != null));
    return sr;
  };
  line(ch.bb_up, css("--s1"));
  line(ch.bb_mid, css("--s1"), { lineStyle: 2, lineWidth: 1 });
  line(ch.bb_lo, css("--s1"));
  line(ch.sma50, css("--s4"));
  line(ch.sma200, css("--s6"));
  const vol = c.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
  c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  vol.setData(ch.t.map((t, i) => ({ time: t, value: ch.v[i] || 0, color: ch.c[i] >= ch.o[i] ? "rgba(34,197,94,.35)" : "rgba(240,82,82,.35)" })));
  const h = s.holding;
  if (h) {
    if (h.stop_loss) cs.createPriceLine({ price: h.stop_loss, color: css("--bear"), lineWidth: 1, lineStyle: 2, title: "סטופ" });
    if (h.take_profit) cs.createPriceLine({ price: h.take_profit, color: css("--bull"), lineWidth: 1, lineStyle: 2, title: "יעד" });
    cs.createPriceLine({ price: h.avg_price, color: css("--text-2"), lineWidth: 1, lineStyle: 1, title: "ממוצע" });
  } else if (s.sizing) {
    cs.createPriceLine({ price: s.sizing.stop, color: css("--bear"), lineWidth: 1, lineStyle: 2, title: "סטופ מוצע" });
    cs.createPriceLine({ price: s.sizing.target, color: css("--bull"), lineWidth: 1, lineStyle: 2, title: "יעד מוצע" });
  }
  // signal markers on the last bar
  const last = candles[candles.length - 1];
  const markers = (s.signals || []).filter((g) => g.dir !== 0 && g.strength >= .6).slice(0, 2).map((g) => ({
    time: last.time, position: g.dir > 0 ? "belowBar" : "aboveBar", color: g.dir > 0 ? css("--bull") : css("--bear"),
    shape: g.dir > 0 ? "arrowUp" : "arrowDown", text: g.title.replace(/^[🛑🎯]\s*/u, "").slice(0, 18) }));
  if (markers.length) cs.setMarkers(markers);
  c.timeScale().fitContent();
  c.subscribeCrosshairMove((p) => {
    const d = p?.seriesData?.get(cs);
    $("#ohlc").textContent = d ? `O ${nf(d.open)}  H ${nf(d.high)}  L ${nf(d.low)}  C ${nf(d.close)}` : "";
  });

  const rc = makeChart("rsi", rel, { rightPriceScale: { borderColor: css("--line"), scaleMargins: { top: .1, bottom: .1 } } });
  const rs = rc.addLineSeries({ color: css("--s3"), lineWidth: 2, priceLineVisible: false });
  rs.setData(ch.t.map((t, i) => ({ time: t, value: ch.rsi[i] })).filter((x) => x.value != null));
  rs.createPriceLine({ price: 70, color: css("--bear"), lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
  rs.createPriceLine({ price: 30, color: css("--bull"), lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
  rc.timeScale().fitContent();
  // keep the two charts in sync
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
      <div class="full row gap">${avatar(me, 44)}<div><b>${esc(me.name)}</b><div class="muted small">${me.is_admin ? "מנהל" : "משתמש"}</div></div></div>
      <label>שם תצוגה<input type="text" name="name" value="${esc(me.name)}" maxlength="30"></label>
      <label>מספר צ׳אט בטלגרם<input type="text" name="telegram_chat_id" value="${esc(me.telegram_chat_id)}" inputmode="numeric" dir="ltr" placeholder="למשל 123456789">
        <span class="hint">${f.telegram_bot ? "שלח /start לבוט של המערכת בטלגרם והדבק כאן את המספר שהוא מחזיר" : "הבוט עוד לא הוגדר – בקש מהמנהל"}</span></label>
      <div class="full"><button class="btn primary">שמור</button></div>
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
        <label>שם<input type="text" name="name" maxlength="30" required></label>
        <label>סיסמה ראשונית<input type="text" name="password" minlength="4" required></label>
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
      <div class="feat"><span>⏱️ תדירות סריקה</span><span class="num">${state.cloud ? "20" : d.status?.interval_min ?? "—"} ד׳</span></div>
      <div class="feat"><span>🔢 סריקות</span><span class="num">${d.status?.scans ?? 0}</span></div>
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
  }
  if (tab === "users") {
    const drawUsers = async () => {
      const list = await api("/api/users");
      if (list.error) { $("#usersList").innerHTML = `<div class="warn-row">${esc(list.error)}</div>`; return; }
      $("#usersList").innerHTML = list.map((u) => `<div class="le-row user-row">
        <span class="row gap">${avatar(u, 30)}<span><b>${esc(u.name)}</b>${u.is_admin ? ` <span class="chip">מנהל</span>` : ""}<div class="muted small">${u.telegram_chat_id ? "📱 טלגרם מחובר" : "ללא טלגרם"}</div></span></span>
        ${u.is_admin ? "<span></span>" : `<button class="btn small" data-rp="${esc(u.id)}">🔑 סיסמה</button>`}
        ${u.is_admin ? "<span></span>" : `<button class="btn small danger" data-du="${esc(u.id)}" data-name="${esc(u.name)}">🗑</button>`}</div>`).join("");
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
  if (tab === "system") $("#sLLM").onclick = async () => { await api("/api/scan?llm=1", { method: "POST" }); closeModal(); toast({ level: "info", title: "סריקה מלאה התחילה", body: "התוצאות יתעדכנו אוטומטית" }); };
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
