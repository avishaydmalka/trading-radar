/**
 * Live market data for the dashboard (Yahoo Finance chart API, no key):
 *  - quotes(): last price, change and intraday sparkline for many tickers (cached ~60s at the edge)
 *  - history(): OHLCV for a chart range (1D … Max), so a stock can be explored back in time
 * Tel Aviv prices arrive in agorot (ILA) and are converted to shekels.
 */

const RANGES = {
  "1d": { range: "1d", interval: "5m", ttl: 60 },
  "5d": { range: "5d", interval: "30m", ttl: 120 },
  "1mo": { range: "1mo", interval: "60m", ttl: 600 },
  "6mo": { range: "6mo", interval: "1d", ttl: 1800 },
  "1y": { range: "1y", interval: "1d", ttl: 1800 },
  "5y": { range: "5y", interval: "1wk", ttl: 6 * 3600 },
  "max": { range: "max", interval: "1mo", ttl: 12 * 3600 },
};

async function cachedJSON(url, ttl) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(url);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit.json();
  }
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (TradingRadar)" } });
  if (!r.ok) return null;
  const data = await r.json();
  if (cache) await cache.put(key, new Response(JSON.stringify(data), { headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` } }));
  return data;
}

function parse(res) {
  const q = res?.indicators?.quote?.[0];
  const m = res?.meta || {};
  if (!res?.timestamp || !q) return null;
  const div = m.currency === "ILA" ? 100 : 1;
  const out = { t: [], o: [], h: [], l: [], c: [], v: [] };
  res.timestamp.forEach((ts, i) => {
    if (q.close[i] == null) return;
    out.t.push(ts);
    out.o.push((q.open[i] ?? q.close[i]) / div); out.h.push((q.high[i] ?? q.close[i]) / div);
    out.l.push((q.low[i] ?? q.close[i]) / div); out.c.push(q.close[i] / div); out.v.push(q.volume[i] || 0);
  });
  const reg = m.currentTradingPeriod?.regular;
  const now = Date.now() / 1000;
  const price = (m.regularMarketPrice ?? out.c[out.c.length - 1]) / div;
  const prev = (m.chartPreviousClose ?? m.previousClose ?? out.c[0]) / div;
  return {
    ...out,
    meta: {
      price, prev_close: prev, change: price - prev, change_pct: prev ? (price / prev - 1) * 100 : 0,
      time: m.regularMarketTime || out.t[out.t.length - 1], live: !!(reg && now >= reg.start && now <= reg.end),
      currency: div === 100 || m.currency === "ILS" ? "ILS" : m.currency || "USD", exchange: m.fullExchangeName || m.exchangeName || "",
      name: m.longName || m.shortName || "", tz: m.exchangeTimezoneName || "",
      session_start: reg?.start, session_end: reg?.end, day_high: m.regularMarketDayHigh / div, day_low: m.regularMarketDayLow / div,
    },
  };
}

export async function history(ticker, rangeKey) {
  const cfg = RANGES[rangeKey] || RANGES["1y"];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${cfg.range}&interval=${cfg.interval}&includePrePost=false`;
  const data = await cachedJSON(url, cfg.ttl).catch(() => null);
  const res = data?.chart?.result?.[0];
  const p = parse(res);
  if (!p) return null;
  return { ticker, range: rangeKey, interval: cfg.interval, intraday: /m$/.test(cfg.interval), ...p };
}

export async function quotes(tickers) {
  const list = [...new Set(tickers.map((t) => String(t).trim().toUpperCase()).filter(Boolean))].slice(0, 40);
  const results = await Promise.all(list.map(async (t) => {
    const h = await history(t, "1d");
    if (!h) return [t, null];
    // a light intraday line (≤ 40 points) for the list sparkline
    const step = Math.max(1, Math.floor(h.c.length / 40));
    return [t, { ...h.meta, spark: h.c.filter((_, i) => i % step === 0 || i === h.c.length - 1) }];
  }));
  return Object.fromEntries(results.filter(([, v]) => v));
}
