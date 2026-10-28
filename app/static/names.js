/* Hebrew display names for Tel Aviv stocks (by symbol, without the .TA suffix) and common pairs.
   Anything not listed falls back to the English name from the data source. */
window.HEB_NAMES = {
  TEVA: "טבע", NICE: "נייס", ESLT: "אלביט מערכות", LUMI: "בנק לאומי", POLI: "בנק הפועלים", DSCT: "בנק דיסקונט",
  MZTF: "מזרחי טפחות", FIBI: "הבינלאומי", ICL: "כיל", TSEM: "טאואר", NVMI: "נובה", CAMT: "קמטק", AZRG: "עזריאלי",
  BEZQ: "בזק", PHOE: "הפניקס", HARL: "הראל", MGDL: "מגדל ביטוח", CLIS: "כלל ביטוח", MMHD: "מנורה מבטחים", ORL: "בזן",
  ENLT: "אנלייט", NWMD: "ניו-מד", SPEN: "שפיר הנדסה", DLEKG: "דלק קבוצה", ELAL: "אל על", ARDM: "אירודרום קבוצה",
  ZOOZ: "זוז פאואר", BONS: "בונוס ביוגרופ", JEEN: "ג'ין טכנולוגיות", MIA: "מיה דיינמיקס", AMOT: "אמות", MLSR: "מליסרון",
  BIG: "ביג", STRS: "שטראוס", SAE: "שופרסל", OPCE: "או.פי.סי אנרגיה", ENOG: "אנרג'יאן", ISCD: "ישראכרט", ONE: "וואן טכנולוגיות",
  FORTY: "פורמולה", MTRX: "מטריקס", SPNS: "ספיינס", NXSN: "נקסט ויז'ן", ELTR: "אלקטרה", ELCO: "אלקו", SKBN: "שיכון ובינוי",
  ALHE: "אלוני חץ", AURA: "אורה", BIMCM: "בית שמש", DANE: "דנאל", ECP: "אלקטרה צריכה", FTAL: "פתאל", GCT: "גב-ים",
  ILCO: "החברה לישראל", ISRA: "ישרס", KEN: "קנון", MGOR: "מגה אור", PRSK: "פריון", RIT1: "ריט 1", SLARL: "סלע נדלן",
  SMT: "סאמיט", TASE: "הבורסה לני\"ע", UNIT: "יוניטרוניקס", ARPT: "אירפורט סיטי", ASHG: "אשטרום", DIMRI: "י.ח. דמרי",
  "TA125": "ת\"א 125", "TA35": "ת\"א 35",
  "ILS=X": "דולר/שקל", "EURILS=X": "אירו/שקל", "CNYILS=X": "יואן/שקל", "ILSCNY=X": "שקל/יואן", "GBPILS=X": "ליש\"ט/שקל",
};

window.hebName = function (ticker, fallback) {
  const t = String(ticker || "").toUpperCase();
  const base = t.replace(/^\^/, "").replace(/\.TA$/, "");
  return window.HEB_NAMES[t] || (t.endsWith(".TA") || t.startsWith("^TA") ? window.HEB_NAMES[base] : null) || fallback || t;
};
