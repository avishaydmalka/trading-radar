/**
 * Jewish calendar quiet windows: Shabbat and Yom Tov (Israel schedule), from candle lighting until havdalah.
 * Times come from Hebcal (free, no key) and are cached in KV for 12 hours. During a window the system
 * does not start scans and sends no Telegram messages or push notifications.
 */
export const CITIES = {
  "281184": "ירושלים", "293397": "תל אביב", "294801": "חיפה", "295530": "באר שבע",
  "294071": "חולון", "293703": "רמת גן", "295629": "אשדוד", "293308": "נתניה",
};
const MARGIN_MS = 10 * 60_000; // start 10 min before candle lighting, end 10 min after havdalah

export async function getShabbatMode(env) {
  const m = (await env.RADAR.get("shabbat_mode", "json")) || {};
  return { enabled: m.enabled !== false, geonameid: m.geonameid || "281184" };
}

function ymd(ms) { return new Date(ms).toISOString().slice(0, 10); }

export async function quietWindows(env, now = Date.now(), force = false) {
  const mode = await getShabbatMode(env);
  const cached = await env.RADAR.get("quiet_windows", "json");
  if (!force && cached && cached.geonameid === mode.geonameid && now - cached.fetched < 12 * 3600_000) return cached;
  const url = "https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&min=off&mod=off&nx=off&ss=off&mf=off&s=on&c=on&M=on&i=on&lg=he"
    + `&geo=geoname&geonameid=${mode.geonameid}&start=${ymd(now - 2 * 86400_000)}&end=${ymd(now + 45 * 86400_000)}`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "trading-radar" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const items = ((await r.json()).items || []).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const windows = [];
    let open = null, names = [];
    for (const it of items) {
      const t = Date.parse(it.date);
      if (it.category === "candles" && open == null) { open = t; names = []; }
      else if (open != null && it.category === "holiday" && it.yomtov) names.push(it.hebrew || it.title);
      else if (open != null && it.category === "parashat") names.push(it.hebrew || it.title);
      else if (it.category === "havdalah" && open != null) {
        const hol = names.filter((n) => !/^פרשת/.test(n));
        const par = names.find((n) => /^פרשת/.test(n));
        windows.push({ start: open - MARGIN_MS, end: t + MARGIN_MS, candles: open, havdalah: t,
          kind: hol.length ? "chag" : "shabbat", title: hol.length ? [...new Set(hol)].join(" · ") : `שבת${par ? ` ${par}` : ""}` });
        open = null;
      }
    }
    const out = { fetched: now, geonameid: mode.geonameid, city: CITIES[mode.geonameid] || mode.geonameid, source: "hebcal", windows };
    await env.RADAR.put("quiet_windows", JSON.stringify(out));
    return out;
  } catch (e) {
    if (cached) return cached;
    return { fetched: 0, source: "fallback", error: String(e), windows: fallbackWindows(now) };
  }
}

/** If Hebcal is unreachable: Friday 12:30 UTC → Saturday 19:30 UTC (covers summer and winter in Israel). */
function fallbackWindows(now) {
  const out = [];
  const d = new Date(now);
  d.setUTCHours(12, 30, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 2) % 7)); // last Friday
  for (let i = 0; i < 3; i++) {
    const start = d.getTime() + i * 7 * 86400_000;
    out.push({ start, end: start + 31 * 3600_000, kind: "shabbat", title: "שבת (זמנים משוערים)" });
  }
  return out;
}

export async function quietNow(env, now = Date.now()) {
  const mode = await getShabbatMode(env);
  const q = await quietWindows(env, now);
  const ws = q.windows || [];
  const current = mode.enabled ? ws.find((w) => w.start <= now && now < w.end) : null;
  const upcoming = ws.find((w) => w.start > now) || null;
  return { enabled: mode.enabled, geonameid: mode.geonameid, city: q.city || CITIES[mode.geonameid], current, upcoming, source: q.source };
}
