// Scriptable widget: status van Radarr, Sonarr en Decypharr.
// Werkt als small, medium en large widget. Tik op de widget om de details te openen.
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

async function arrStatus(name, cfg, missingPath) {
  const base = trimUrl(cfg.url) + "/api/v3";
  const h = { "X-Api-Key": cfg.apiKey };
  try {
    const [status, health, queue, missing] = await Promise.all([
      getJSON(`${base}/system/status`, h),
      getJSON(`${base}/health`, h),
      getJSON(`${base}/queue?pageSize=1`, h),
      getJSON(`${base}/${missingPath}?pageSize=1&monitored=true`, h),
    ]);
    const issues = (health || []).filter((x) => x.type !== "notice");
    const errors = issues.filter((x) => x.type === "error");
    return {
      name,
      url: cfg.url,
      online: true,
      level: errors.length ? "err" : issues.length ? "warn" : "ok",
      version: status.version,
      lines: [
        `Queue: ${queue.totalRecords ?? 0}`,
        `Missing: ${missing.totalRecords ?? 0}`,
        issues.length ? `Health: ${issues.length} issue(s)` : "Health: OK",
      ],
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
    const s = await getJSON(`${base}/debug/stats`, h);
    const details = [];
    let level = "ok";

    const mount = s.mount || {};
    if (mount.enabled && !mount.ready) {
      level = "err";
      details.push(`Mount niet ready${mount.error ? ": " + mount.error : ""}`);
    }

    const health = (s.repair && s.repair.health) || {};
    const broken = health.broken || 0;
    if (broken > 0) {
      if (level === "ok") level = "warn";
      details.push(`${broken} kapotte item(s) in repair`);
    }

    let bad = 0;
    const now = Date.now();
    for (const d of s.debrids || []) {
      bad += (d.library && d.library.bad) || 0;
      const p = d.profile;
      if (p && p.expiration) {
        const days = Math.floor((new Date(p.expiration).getTime() - now) / 86400000);
        if (days >= 0 && days < 3650) {
          details.push(`${p.name || "debrid"}: premium nog ${days} dagen`);
          if (days < 7 && level === "ok") level = "warn";
        }
      }
    }

    const q = s.queue || {};
    return {
      name: "Decypharr",
      url: cfg.url,
      online: true,
      level,
      version: s.system && s.system.uptime ? `up ${s.system.uptime}` : "",
      lines: [
        `Queue: ${q.active ?? 0} actief / ${q.pending ?? 0} wacht`,
        `Streams: ${(s.active_streams && s.active_streams.count) || 0}`,
        broken || bad ? `Broken: ${broken} · Bad: ${bad}` : "Library: OK",
      ],
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
    lines: ["Offline"],
    details: [String(e.message || e)],
  };
}

function levelColor(l) {
  return l === "ok" ? COLORS.ok : l === "warn" ? COLORS.warn : COLORS.err;
}

function addService(stack, svc, compact) {
  const row = stack.addStack();
  row.layoutVertically();

  const head = row.addStack();
  head.centerAlignContent();
  const dot = head.addText("●");
  dot.font = Font.systemFont(compact ? 10 : 12);
  dot.textColor = levelColor(svc.level);
  head.addSpacer(4);
  const t = head.addText(svc.name);
  t.font = Font.boldSystemFont(compact ? 12 : 14);
  t.textColor = COLORS.text;
  if (!compact && svc.version) {
    head.addSpacer(6);
    const v = head.addText(svc.version);
    v.font = Font.systemFont(10);
    v.textColor = COLORS.sub;
    v.lineLimit = 1;
  }

  const lines = compact ? [svc.online ? svc.lines[0] : "Offline"] : svc.lines;
  for (const l of lines) {
    const x = row.addText(l);
    x.font = Font.systemFont(compact ? 10 : 11);
    x.textColor = COLORS.sub;
    x.lineLimit = 1;
  }
}

function buildWidget(services) {
  const w = new ListWidget();
  w.backgroundColor = COLORS.bg;
  w.setPadding(12, 12, 12, 12);
  w.refreshAfterDate = new Date(Date.now() + CONFIG.refreshMinutes * 60000);

  const family = config.widgetFamily || "large";

  if (family === "small") {
    for (const s of services) {
      addService(w, s, true);
      w.addSpacer(6);
    }
  } else if (family === "medium") {
    const row = w.addStack();
    row.topAlignContent();
    services.forEach((s, i) => {
      const col = row.addStack();
      col.layoutVertically();
      addService(col, s, false);
      if (i < services.length - 1) row.addSpacer();
    });
    w.addSpacer();
  } else {
    for (const s of services) {
      addService(w, s, false);
      if (s.details.length) {
        for (const d of s.details.slice(0, 2)) {
          const x = w.addText("• " + d);
          x.font = Font.systemFont(10);
          x.textColor = levelColor(s.level);
          x.lineLimit = 1;
        }
      }
      w.addSpacer(8);
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
    for (const l of [...s.lines, ...s.details]) {
      const r = new UITableRow();
      r.addText(l);
      table.addRow(r);
    }
  }
  await table.present();
}

const services = await Promise.all([
  arrStatus("Radarr", CONFIG.radarr, "wanted/missing"),
  arrStatus("Sonarr", CONFIG.sonarr, "wanted/missing"),
  decypharrStatus(CONFIG.decypharr),
]);

if (config.runsInWidget) {
  Script.setWidget(buildWidget(services));
} else {
  await showTable(services);
}
Script.complete();
