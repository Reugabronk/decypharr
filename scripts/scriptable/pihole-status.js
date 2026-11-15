// Scriptable widget: Pi-hole v6 status.
//   small:  % geblokkeerd, queries, blocked, status
//   medium: cijfers + grafiek van de laatste 24 uur
//   large:  cijfers + grafiek + top 3 geblokkeerde domeinen + top 3 clients
//
// In de app (of via tik op de widget): menu om blocking te pauzeren / aan te zetten.
// Via Shortcuts/Siri: geef als parameter "pause5", "pause30", "pause60", "enable" of "status".
//
// Wachtwoord: gebruik bij voorkeur een app password
//   (Pi-hole > Settings > Web interface / API > Expert-modus > "Configure app password").
//   Dat werkt ook als je 2FA aan hebt. Leeg laten als je Pi-hole geen wachtwoord heeft.
// Gebruik http:// — https met het self-signed certificaat van Pi-hole weigert iOS.

const CONFIG = {
  name: "Pi-hole",
  url: "http://192.168.1.2",
  password: "VUL_IN",
  timeoutSeconds: 8,
  refreshMinutes: 15,
};

// ---------------------------------------------------------------------------

const COLORS = {
  bg: Color.dynamic(new Color("#f4f4f6"), new Color("#16181d")),
  text: Color.dynamic(new Color("#16181d"), new Color("#f2f2f5")),
  sub: Color.dynamic(new Color("#6b6f78"), new Color("#9a9fa8")),
  ok: new Color("#2fb36d"),
  warn: new Color("#e6a23c"),
  err: new Color("#e5484d"),
  total: new Color("#3b82f6"),
  blocked: new Color("#e5484d"),
};

const BASE = CONFIG.url.replace(/\/+$/, "") + "/api";
const SID_KEY = "pihole_sid_" + CONFIG.url;

function getSid() {
  try {
    return Keychain.contains(SID_KEY) ? Keychain.get(SID_KEY) : null;
  } catch (e) {
    return null;
  }
}
function setSid(sid) {
  try {
    if (sid) Keychain.set(SID_KEY, sid);
    else if (Keychain.contains(SID_KEY)) Keychain.remove(SID_KEY);
  } catch (e) {}
}

async function rawRequest(method, path, body, sid) {
  const req = new Request(BASE + path);
  req.method = method;
  req.timeoutInterval = CONFIG.timeoutSeconds;
  req.headers = { "Content-Type": "application/json" };
  if (sid) req.headers["X-FTL-SID"] = sid;
  if (body) req.body = JSON.stringify(body);
  let json = null;
  try {
    json = await req.loadJSON();
  } catch (e) {
    if (!req.response) throw e; // netwerkfout
  }
  return { code: (req.response && req.response.statusCode) || 0, json };
}

// Hergebruikt de sessie uit de Keychain zodat Pi-hole niet bij elke refresh
// een nieuwe sessie aanmaakt (v6 heeft een max aantal sessies).
async function login() {
  const r = await rawRequest("POST", "/auth", { password: String(CONFIG.password).trim() });
  const s = r.json && r.json.session;
  if (!s || !s.valid) {
    if (r.code === 404 || (!r.json && r.code)) {
      throw new Error(`Login mislukt (HTTP ${r.code}): geen Pi-hole v6 API op ${BASE}/auth. Klopt de URL/poort en draai je Pi-hole v6?`);
    }
    const msg = (r.json && r.json.error && (r.json.error.message + (r.json.error.hint ? " – " + r.json.error.hint : ""))) || (s && s.message) || "onbekend";
    const hint = s && s.totp ? " (2FA staat aan: gebruik een app password)" : "";
    throw new Error(`Login mislukt (HTTP ${r.code}): ${msg}${hint}`);
  }
  setSid(s.sid || null); // sid is null als er geen wachtwoord nodig is
  return s.sid || null;
}

// Eén gedeelde login, zodat parallelle requests niet elk een sessie aanmaken.
let loginPromise = null;
function sharedLogin(staleSid) {
  if (!loginPromise || loginPromise.staleSid !== staleSid) {
    loginPromise = login();
    loginPromise.staleSid = staleSid;
  }
  return loginPromise;
}

async function api(method, path, body) {
  let sid = getSid();
  let r = await rawRequest(method, path, body, sid);
  if (r.code === 401 || r.code === 403) {
    sid = await sharedLogin(sid);
    r = await rawRequest(method, path, body, sid);
  }
  if (r.code >= 400 || !r.json) {
    const msg = (r.json && r.json.error && r.json.error.message) || "";
    throw new Error(`HTTP ${r.code}${msg ? ": " + msg : ""} (${path})`);
  }
  return r.json;
}

async function loadData() {
  const [summary, blocking, history, topBlocked, topClients] = await Promise.all([
    api("GET", "/stats/summary"),
    api("GET", "/dns/blocking"),
    api("GET", "/history"),
    api("GET", "/stats/top_domains?blocked=true&count=3"),
    api("GET", "/stats/top_clients?count=3"),
  ]);
  const q = summary.queries || {};
  return {
    online: true,
    total: q.total || 0,
    blocked: q.blocked || 0,
    pct: q.percent_blocked || 0,
    clients: (summary.clients && summary.clients.active) || 0,
    gravity: (summary.gravity && summary.gravity.domains_being_blocked) || 0,
    gravityUpdated: summary.gravity && summary.gravity.last_update,
    blocking: blocking.blocking, // "enabled" | "disabled" | "failed" | "unknown"
    timer: blocking.timer, // seconden tot blocking weer aangaat, of null
    history: history.history || [],
    topBlocked: topBlocked.domains || [],
    topClients: topClients.clients || [],
  };
}

async function setBlocking(enabled, seconds) {
  return api("POST", "/dns/blocking", { blocking: enabled, timer: enabled ? null : seconds || null });
}

// ---------------------------------------------------------------------------

function fmtNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(".", ",") + "M";
  if (n >= 1e4) return Math.round(n / 1e3) + "k";
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function fmtPct(p) {
  return p.toFixed(1).replace(".", ",") + "%";
}

function statusInfo(d) {
  if (!d.online) return { color: COLORS.err, text: "Offline" };
  if (d.blocking === "enabled") return { color: COLORS.ok, text: "Actief" };
  if (d.blocking === "disabled") {
    const t = d.timer ? ` (${Math.ceil(d.timer / 60)}m)` : "";
    return { color: COLORS.warn, text: "Gepauzeerd" + t };
  }
  return { color: COLORS.err, text: d.blocking || "?" };
}

function chart(history, width, height) {
  const ctx = new DrawContext();
  ctx.size = new Size(width, height);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  if (!history.length) return ctx.getImage();
  const max = Math.max(1, ...history.map((h) => h.total || 0));
  const n = history.length;
  const bw = width / n;
  for (let i = 0; i < n; i++) {
    const h = history[i];
    const th = ((h.total || 0) / max) * height;
    const bh = ((h.blocked || 0) / max) * height;
    const x = i * bw;
    const w = Math.max(1, bw - (bw > 3 ? 1 : 0));
    ctx.setFillColor(new Color(COLORS.total.hex, 0.55));
    ctx.fillRect(new Rect(x, height - th, w, th));
    ctx.setFillColor(COLORS.blocked);
    ctx.fillRect(new Rect(x, height - bh, w, bh));
  }
  return ctx.getImage();
}

function addHeader(w, d) {
  const st = statusInfo(d);
  const head = w.addStack();
  head.centerAlignContent();
  const dot = head.addText("●");
  dot.font = Font.systemFont(11);
  dot.textColor = st.color;
  head.addSpacer(4);
  const t = head.addText(CONFIG.name);
  t.font = Font.boldSystemFont(13);
  t.textColor = COLORS.text;
  head.addSpacer();
  const s = head.addText(st.text);
  s.font = Font.systemFont(10);
  s.textColor = st.color;
}

function addStat(stack, value, label, color) {
  const col = stack.addStack();
  col.layoutVertically();
  const v = col.addText(value);
  v.font = Font.boldRoundedSystemFont(18);
  v.textColor = color || COLORS.text;
  v.minimumScaleFactor = 0.6;
  v.lineLimit = 1;
  const l = col.addText(label);
  l.font = Font.systemFont(9);
  l.textColor = COLORS.sub;
}

function addList(w, title, rows) {
  const t = w.addText(title);
  t.font = Font.semiboldSystemFont(10);
  t.textColor = COLORS.sub;
  w.addSpacer(2);
  if (!rows.length) {
    const x = w.addText("—");
    x.font = Font.systemFont(10);
    x.textColor = COLORS.sub;
  }
  for (const [label, count] of rows) {
    const r = w.addStack();
    const a = r.addText(label);
    a.font = Font.systemFont(11);
    a.textColor = COLORS.text;
    a.lineLimit = 1;
    r.addSpacer(6);
    const b = r.addText(fmtNum(count));
    b.font = Font.semiboldMonospacedSystemFont(10);
    b.textColor = COLORS.sub;
  }
}

function buildWidget(d) {
  const w = new ListWidget();
  w.backgroundColor = COLORS.bg;
  w.setPadding(12, 14, 10, 14);
  w.refreshAfterDate = new Date(Date.now() + CONFIG.refreshMinutes * 60000);
  const family = config.widgetFamily || "large";

  addHeader(w, d);
  w.addSpacer(6);

  if (!d.online) {
    const x = w.addText(d.error);
    x.font = Font.systemFont(11);
    x.textColor = COLORS.err;
    x.lineLimit = 4;
    w.addSpacer();
  } else if (family === "small") {
    const big = w.addText(fmtPct(d.pct));
    big.font = Font.boldRoundedSystemFont(30);
    big.textColor = COLORS.blocked;
    big.minimumScaleFactor = 0.6;
    const l = w.addText("geblokkeerd vandaag");
    l.font = Font.systemFont(9);
    l.textColor = COLORS.sub;
    w.addSpacer();
    const row = w.addStack();
    addStat(row, fmtNum(d.total), "queries");
    row.addSpacer();
    addStat(row, fmtNum(d.blocked), "blocked", COLORS.blocked);
  } else {
    const row = w.addStack();
    addStat(row, fmtNum(d.total), "queries");
    row.addSpacer();
    addStat(row, fmtNum(d.blocked), "blocked", COLORS.blocked);
    row.addSpacer();
    addStat(row, fmtPct(d.pct), "% blocked", COLORS.blocked);
    row.addSpacer();
    addStat(row, String(d.clients), "clients");
    w.addSpacer(8);

    const chartW = 300;
    const chartH = family === "medium" ? 34 : 60;
    const img = w.addImage(chart(d.history, chartW, chartH));
    img.imageSize = new Size(chartW, chartH);
    img.centerAlignImage();

    if (family === "large") {
      w.addSpacer(10);
      addList(w, "TOP GEBLOKKEERD", d.topBlocked.map((x) => [x.domain, x.count]));
      w.addSpacer(8);
      addList(w, "TOP CLIENTS", d.topClients.map((x) => [x.name || x.ip, x.count]));
      w.addSpacer(6);
      const g = w.addText(`${fmtNum(d.gravity)} domeinen op de blocklist`);
      g.font = Font.systemFont(9);
      g.textColor = COLORS.sub;
    }
    w.addSpacer();
  }

  const f = new DateFormatter();
  f.useNoDateStyle();
  f.useShortTimeStyle();
  const upd = w.addText("Bijgewerkt " + f.string(new Date()));
  upd.font = Font.systemFont(8);
  upd.textColor = COLORS.sub;
  w.url = URLScheme.forRunningScript();
  return w;
}

// ---------------------------------------------------------------------------

async function runAction(action) {
  const m = String(action || "").trim().toLowerCase();
  if (m === "enable") {
    await setBlocking(true);
    return "Blocking staat weer aan";
  }
  const p = m.match(/^pause(\d+)$/);
  if (p) {
    await setBlocking(false, +p[1] * 60);
    return `Blocking ${p[1]} minuten gepauzeerd`;
  }
  return null;
}

async function main() {
  let d;
  try {
    d = await loadData();
  } catch (e) {
    d = { online: false, error: String(e.message || e) };
  }

  // Shortcuts / Siri
  if (args.shortcutParameter) {
    let msg;
    try {
      msg = await runAction(args.shortcutParameter);
    } catch (e) {
      msg = "Fout: " + (e.message || e);
    }
    if (!msg) {
      msg = d.online
        ? `${CONFIG.name}: ${statusInfo(d).text}. ${fmtNum(d.total)} queries, ${fmtNum(d.blocked)} geblokkeerd (${fmtPct(d.pct)}).`
        : `${CONFIG.name} offline: ${d.error}`;
    }
    Script.setShortcutOutput(msg);
    return;
  }

  if (config.runsInWidget) {
    Script.setWidget(buildWidget(d));
    return;
  }

  // In de app: menu
  const a = new Alert();
  a.title = `${CONFIG.name} · ${statusInfo(d).text}`;
  a.message = d.online
    ? `${fmtNum(d.total)} queries · ${fmtNum(d.blocked)} blocked (${fmtPct(d.pct)}) · ${d.clients} clients`
    : d.error;
  const actions = [];
  if (d.online && d.blocking === "enabled") {
    for (const mins of [5, 30, 60]) {
      a.addAction(`Pauzeer ${mins} min`);
      actions.push("pause" + mins);
    }
  } else if (d.online) {
    a.addAction("Blocking aanzetten");
    actions.push("enable");
  }
  a.addAction("Widget bekijken");
  actions.push("preview");
  a.addAction("Open Pi-hole");
  actions.push("open");
  a.addCancelAction("Sluiten");
  const i = await a.presentSheet();
  if (i < 0) return;
  const act = actions[i];
  if (act === "preview") return buildWidget(d).presentLarge();
  if (act === "open") return Safari.open(CONFIG.url.replace(/\/+$/, "") + "/admin/");
  try {
    const msg = await runAction(act);
    const ok = new Alert();
    ok.title = msg;
    ok.addAction("OK");
    await ok.present();
  } catch (e) {
    const err = new Alert();
    err.title = "Mislukt";
    err.message = String(e.message || e);
    err.addAction("OK");
    await err.present();
  }
}

await main();
Script.complete();
