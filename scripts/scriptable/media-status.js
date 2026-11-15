// Scriptable widget: status van Radarr, Sonarr en Decypharr.
// Toont per service de eerste 3 items uit de wachtrij met % en resterende tijd.
//   small:  status + aantal in queue + de eerstvolgende download
//   medium: de eerste 3 over Radarr/Sonarr/Decypharr samen (eerst klaar bovenaan)
//   large:  per service de eerste 3
// Tik op de widget om de details te openen.
//
// Installatie:
//   1. Installeer Scriptable uit de App Store.
//   2. Maak een nieuw script, plak deze file erin, vul CONFIG hieronder in.
//   3. Voeg een Scriptable-widget toe aan je beginscherm en kies dit script.
//
// API-keys:
//   Radarr/Sonarr: Settings > General > Security > API Key
//   Decypharr:     Settings > Auth > API token (alleen nodig als auth aan staat)

const CONFIG = {
  radarr: {
    url: "http://192.168.1.10:7878",
    apiKey: "VUL_IN",
  },
  sonarr: {
    url: "http://192.168.1.10:8989",
    apiKey: "VUL_IN",
  },
  decypharr: {
    url: "http://192.168.1.10:8282",
    apiToken: "", // leeg laten als auth uit staat
  },
  queueItems: 3, // hoeveel items uit de wachtrij tonen
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
};

async function getJSON(url, headers) {
  const req = new Request(url);
  req.headers = headers;
  req.timeoutInterval = CONFIG.timeoutSeconds;
  const body = await req.loadJSON();
  const code = req.response && req.response.statusCode;
  if (code && code >= 400) {
    const msg = (body && (body.message || body.error)) || "";
    throw new Error(`HTTP ${code}${msg ? ": " + msg : ""}`);
  }
  return body;
}

function trimUrl(u) {
  return u.replace(/\/+$/, "");
}

// "00:12:34" of "1.02:03:04" (Radarr/Sonarr) -> seconden
function parseTimeleft(t) {
  if (!t) return null;
  const m = String(t).match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+)/);
  if (!m) return null;
  return (+(m[1] || 0)) * 86400 + (+m[2]) * 3600 + (+m[3]) * 60 + (+m[4]);
}

function fmtDuration(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return "?";
  if (sec < 60) return "<1m";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}u`;
  if (h) return `${h}u ${m}m`;
  return `${m}m`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function arrItemTitle(item) {
  if (item.series && item.episode) {
    const e = item.episode;
    return `${item.series.title} S${pad2(e.seasonNumber)}E${pad2(e.episodeNumber)}`;
  }
  if (item.movie) return item.movie.title + (item.movie.year ? ` (${item.movie.year})` : "");
  return item.title || "?";
}

function arrItemState(item) {
  const st = (item.trackedDownloadState || item.status || "").toLowerCase();
  if (item.trackedDownloadStatus === "warning" || item.trackedDownloadStatus === "error") return "warn";
  if (st === "importpending" || st === "importing") return "import";
  if (st === "queued" || st === "delay" || st === "paused") return "wacht";
  return "";
}

async function arrStatus(name, cfg, extra) {
  const base = trimUrl(cfg.url) + "/api/v3";
  const h = { "X-Api-Key": cfg.apiKey };
  try {
    const [status, health, queue, missing] = await Promise.all([
      getJSON(`${base}/system/status`, h),
      getJSON(`${base}/health`, h),
      getJSON(`${base}/queue?page=1&pageSize=${CONFIG.queueItems}&sortKey=timeleft&sortDirection=ascending&${extra}`, h),
      getJSON(`${base}/wanted/missing?pageSize=1&monitored=true`, h),
    ]);
    const issues = (health || []).filter((x) => x.type !== "notice");
    const errors = issues.filter((x) => x.type === "error");
    const items = (queue.records || []).map((r) => {
      const size = r.size || 0;
      const left = r.sizeleft || 0;
      return {
        title: arrItemTitle(r),
        pct: size > 0 ? Math.max(0, Math.min(100, ((size - left) / size) * 100)) : 0,
        eta: parseTimeleft(r.timeleft),
        state: arrItemState(r),
      };
    });
    return {
      name,
      url: cfg.url,
      online: true,
      level: errors.length ? "err" : issues.length ? "warn" : "ok",
      version: status.version,
      queueTotal: queue.totalRecords ?? items.length,
      summary: `${queue.totalRecords ?? 0} in queue · ${missing.totalRecords ?? 0} missing`,
      items,
      details: issues.map((x) => `[${x.type}] ${x.message}`),
    };
  } catch (e) {
    return offline(name, cfg.url, e);
  }
}

async function decypharrStatus(cfg) {
  const base = trimUrl(cfg.url);
  const h = cfg.apiToken ? { Authorization: `Bearer ${cfg.apiToken}` } : {};
  try {
    const [s, q] = await Promise.all([
      getJSON(`${base}/debug/stats`, h),
      getJSON(`${base}/api/torrents?state=downloading&limit=${CONFIG.queueItems}&sort_by=progress&sort_order=desc`, h),
    ]);
    const details = [];
    let level = "ok";

    const mount = s.mount || {};
    if (mount.enabled && !mount.ready) {
      level = "err";
      details.push(`Mount niet ready${mount.error ? ": " + mount.error : ""}`);
    }
    const broken = ((s.repair && s.repair.health) || {}).broken || 0;
    if (broken > 0) {
      if (level === "ok") level = "warn";
      details.push(`${broken} kapotte item(s) in repair`);
    }
    const now = Date.now();
    for (const d of s.debrids || []) {
      const p = d.profile;
      if (p && p.expiration) {
        const days = Math.floor((new Date(p.expiration).getTime() - now) / 86400000);
        if (days >= 0 && days < 3650) {
          details.push(`${p.name || "debrid"}: premium nog ${days} dagen`);
          if (days < 7 && level === "ok") level = "warn";
        }
      }
    }

    // progress is 0..1 in Decypharr
    const items = (q.torrents || []).map((t) => {
      const frac = Math.max(0, Math.min(1, t.progress || 0));
      const size = t.bytes || t.size || 0;
      const speed = t.speed || 0;
      return {
        title: t.name || "?",
        pct: frac * 100,
        eta: speed > 0 && size > 0 ? (size * (1 - frac)) / speed : null,
        state: "",
      };
    });

    const qs = s.queue || {};
    return {
      name: "Decypharr",
      url: cfg.url,
      online: true,
      level,
      version: s.system && s.system.uptime ? `up ${s.system.uptime}` : "",
      queueTotal: q.total ?? items.length,
      summary: `${qs.active ?? 0} actief · ${qs.pending ?? 0} wacht · ${(s.active_streams && s.active_streams.count) || 0} streams`,
      items,
      details,
    };
  } catch (e) {
    return offline("Decypharr", cfg.url, e);
  }
}

function offline(name, url, e) {
  return {
    name,
    url,
    online: false,
    level: "err",
    version: "",
    queueTotal: 0,
    summary: "Offline",
    items: [],
    details: [String(e.message || e)],
  };
}

function levelColor(l) {
  return l === "ok" ? COLORS.ok : l === "warn" ? COLORS.warn : COLORS.err;
}

function progressBar(pct, color, width) {
  const h = 4;
  const ctx = new DrawContext();
  ctx.size = new Size(width, h);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const track = new Path();
  track.addRoundedRect(new Rect(0, 0, width, h), 2, 2);
  ctx.addPath(track);
  ctx.setFillColor(new Color("#888888", 0.25));
  ctx.fillPath();
  const w = Math.max(h, (width * Math.min(100, pct)) / 100);
  const bar = new Path();
  bar.addRoundedRect(new Rect(0, 0, w, h), 2, 2);
  ctx.addPath(bar);
  ctx.setFillColor(color);
  ctx.fillPath();
  return ctx.getImage();
}

function itemRight(it) {
  const pct = `${Math.floor(it.pct)}%`;
  if (it.state === "import") return `${pct} · import`;
  if (it.state === "wacht") return `${pct} · wacht`;
  return `${pct} · ${fmtDuration(it.eta)}`;
}

function addItem(stack, it, barWidth, prefix) {
  const row = stack.addStack();
  row.centerAlignContent();
  const t = row.addText((prefix ? prefix + " " : "") + it.title);
  t.font = Font.systemFont(11);
  t.textColor = COLORS.text;
  t.lineLimit = 1;
  row.addSpacer(6);
  const r = row.addText(itemRight(it));
  r.font = Font.semiboldMonospacedSystemFont(10);
  r.textColor = it.state === "warn" ? COLORS.warn : COLORS.sub;
  stack.addSpacer(2);
  const img = stack.addImage(progressBar(it.pct, it.state === "warn" ? COLORS.warn : COLORS.ok, barWidth));
  img.imageSize = new Size(barWidth, 4);
  stack.addSpacer(4);
}

function addHeader(stack, svc, showSummary) {
  const head = stack.addStack();
  head.centerAlignContent();
  const dot = head.addText("●");
  dot.font = Font.systemFont(11);
  dot.textColor = levelColor(svc.level);
  head.addSpacer(4);
  const t = head.addText(svc.name);
  t.font = Font.boldSystemFont(13);
  t.textColor = COLORS.text;
  if (showSummary) {
    head.addSpacer();
    const v = head.addText(svc.summary);
    v.font = Font.systemFont(10);
    v.textColor = svc.online ? COLORS.sub : COLORS.err;
    v.lineLimit = 1;
  }
  stack.addSpacer(3);
}

function buildWidget(services) {
  const w = new ListWidget();
  w.backgroundColor = COLORS.bg;
  w.setPadding(12, 14, 10, 14);
  w.refreshAfterDate = new Date(Date.now() + CONFIG.refreshMinutes * 60000);

  const family = config.widgetFamily || "large";
  const barWidth = family === "small" ? 130 : 300;

  if (family === "small") {
    // alleen status + aantal in de queue per service
    for (const s of services) {
      const row = w.addStack();
      row.centerAlignContent();
      const dot = row.addText("●");
      dot.font = Font.systemFont(10);
      dot.textColor = levelColor(s.level);
      row.addSpacer(4);
      const t = row.addText(s.name);
      t.font = Font.boldSystemFont(12);
      t.textColor = COLORS.text;
      row.addSpacer();
      const c = row.addText(s.online ? String(s.queueTotal) : "off");
      c.font = Font.semiboldMonospacedSystemFont(12);
      c.textColor = s.online ? COLORS.sub : COLORS.err;
      w.addSpacer(6);
    }
    // eerstvolgende download eronder
    const next = services.flatMap((s) => s.items).filter((i) => !i.state).sort((a, b) => (a.eta ?? 1e12) - (b.eta ?? 1e12))[0];
    if (next) {
      w.addSpacer(2);
      addItem(w, next, barWidth);
    }
  } else if (family === "medium") {
    // statusregel + de eerste N over alle services samen
    const head = w.addStack();
    head.centerAlignContent();
    services.forEach((s, i) => {
      const dot = head.addText("●");
      dot.font = Font.systemFont(10);
      dot.textColor = levelColor(s.level);
      head.addSpacer(3);
      const t = head.addText(`${s.name} ${s.online ? s.queueTotal : "off"}`);
      t.font = Font.boldSystemFont(11);
      t.textColor = COLORS.text;
      if (i < services.length - 1) head.addSpacer(10);
    });
    w.addSpacer(6);
    const tag = { Radarr: "🎬", Sonarr: "📺", Decypharr: "⬇️" };
    const all = services
      .flatMap((s) => s.items.map((it) => ({ ...it, prefix: tag[s.name] || "" })))
      .sort((a, b) => (a.eta ?? 1e12) - (b.eta ?? 1e12))
      .slice(0, CONFIG.queueItems);
    if (!all.length) {
      const x = w.addText("Niets in de wachtrij");
      x.font = Font.systemFont(11);
      x.textColor = COLORS.sub;
    }
    for (const it of all) addItem(w, it, barWidth, it.prefix);
    w.addSpacer();
  } else {
    // large: per service de eerste N
    for (const s of services) {
      addHeader(w, s, true);
      if (!s.online) {
        const x = w.addText(s.details[0] || "Offline");
        x.font = Font.systemFont(10);
        x.textColor = COLORS.err;
        x.lineLimit = 1;
      } else if (!s.items.length) {
        const x = w.addText(s.details[0] ? "• " + s.details[0] : "Niets in de wachtrij");
        x.font = Font.systemFont(10);
        x.textColor = s.details[0] ? levelColor(s.level) : COLORS.sub;
        x.lineLimit = 1;
      }
      for (const it of s.items) addItem(w, it, barWidth);
      w.addSpacer(6);
    }
    w.addSpacer();
  }

  const f = new DateFormatter();
  f.useNoDateStyle();
  f.useShortTimeStyle();
  const upd = w.addText("Bijgewerkt " + f.string(new Date()));
  upd.font = Font.systemFont(8);
  upd.textColor = COLORS.sub;
  return w;
}

async function showTable(services) {
  const table = new UITable();
  table.showSeparators = true;
  for (const s of services) {
    const h = new UITableRow();
    h.isHeader = true;
    h.addText(`${s.level === "ok" ? "🟢" : s.level === "warn" ? "🟠" : "🔴"} ${s.name}`, s.version);
    h.onSelect = () => Safari.open(s.url);
    table.addRow(h);
    for (const l of [s.summary, ...s.items.map((it) => `${it.title} — ${itemRight(it)}`), ...s.details]) {
      const r = new UITableRow();
      r.addText(l);
      table.addRow(r);
    }
  }
  await table.present();
}

const services = await Promise.all([
  arrStatus("Radarr", CONFIG.radarr, "includeMovie=true"),
  arrStatus("Sonarr", CONFIG.sonarr, "includeSeries=true&includeEpisode=true"),
  decypharrStatus(CONFIG.decypharr),
]);

if (config.runsInWidget) {
  Script.setWidget(buildWidget(services));
} else {
  await showTable(services);
}
Script.complete();
