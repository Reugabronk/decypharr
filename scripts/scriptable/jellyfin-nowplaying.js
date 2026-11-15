// Scriptable widget: wat er nu op Jellyfin wordt afgespeeld.
// Per stream: poster, titel, gebruiker, apparaat en een voortgangsbalk zoals
// in de player, met verstreken tijd links en totale duur rechts.
//
//   small:  1 stream
//   medium: 2 streams
//   large:  4 streams
//
// De verstreken tijd loopt live mee in de widget (iOS timer), ook tussen
// refreshes door. De balk zelf wordt alleen bij een refresh bijgewerkt.
//
// API key: Jellyfin Dashboard > API Keys > "+". Zo'n key ziet alle sessies.

const CONFIG = {
  url: "http://192.168.1.10:8096",
  apiKey: "VUL_IN",
  showPosters: true,
  timeoutSeconds: 8,
  refreshMinutes: 5,
};

// ---------------------------------------------------------------------------

const COLORS = {
  bg: Color.dynamic(new Color("#f4f4f6"), new Color("#101318")),
  text: Color.dynamic(new Color("#16181d"), new Color("#f2f2f5")),
  sub: Color.dynamic(new Color("#6b6f78"), new Color("#9a9fa8")),
  accent: new Color("#00a4dc"), // Jellyfin-blauw
  track: new Color("#888888", 0.3),
  paused: new Color("#e6a23c"),
  err: new Color("#e5484d"),
};

const BASE = CONFIG.url.replace(/\/+$/, "");
const TICKS = 10000000; // Jellyfin ticks per seconde

function headers() {
  return {
    Authorization: `MediaBrowser Client="Scriptable", Device="iPhone", DeviceId="scriptable-widget", Version="1.0", Token="${CONFIG.apiKey}"`,
  };
}

async function getJSON(path) {
  const req = new Request(BASE + path);
  req.headers = headers();
  req.timeoutInterval = CONFIG.timeoutSeconds;
  const body = await req.loadJSON();
  const code = req.response && req.response.statusCode;
  if (code && code >= 400) throw new Error(`HTTP ${code}${code === 401 ? " (API key klopt niet)" : ""}`);
  return body;
}

async function getImage(path) {
  try {
    const req = new Request(BASE + path);
    req.headers = headers();
    req.timeoutInterval = CONFIG.timeoutSeconds;
    return await req.loadImage();
  } catch (e) {
    return null;
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// seconden -> "47:12" of "1:12:05"
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

function describe(item) {
  if (item.Type === "Episode") {
    const se =
      item.ParentIndexNumber != null && item.IndexNumber != null
        ? `S${pad2(item.ParentIndexNumber)}E${pad2(item.IndexNumber)} · `
        : "";
    return { title: item.SeriesName || item.Name, subtitle: se + item.Name, posterId: item.SeriesId || item.Id };
  }
  if (item.Type === "Movie") {
    return { title: item.Name, subtitle: item.ProductionYear ? String(item.ProductionYear) : "Film", posterId: item.Id };
  }
  if (item.Type === "Audio") {
    return { title: item.Name, subtitle: [item.AlbumArtist || (item.Artists || [])[0], item.Album].filter(Boolean).join(" · "), posterId: item.AlbumId || item.Id };
  }
  return { title: item.Name, subtitle: item.Type || "", posterId: item.Id };
}

async function loadSessions() {
  const sessions = await getJSON("/Sessions?activeWithinSeconds=960");
  const playing = (sessions || [])
    .filter((s) => s.NowPlayingItem)
    .sort((a, b) => new Date(b.LastActivityDate || 0) - new Date(a.LastActivityDate || 0));

  return Promise.all(
    playing.map(async (s) => {
      const item = s.NowPlayingItem;
      const ps = s.PlayState || {};
      const d = describe(item);
      const duration = (item.RunTimeTicks || 0) / TICKS;
      const position = (ps.PositionTicks || 0) / TICKS;
      const transcoding = ps.PlayMethod === "Transcode";
      return {
        user: s.UserName || "?",
        device: [s.Client, s.DeviceName].filter(Boolean).join(" · "),
        title: d.title,
        subtitle: d.subtitle,
        duration,
        position,
        paused: !!ps.IsPaused,
        transcoding,
        poster: CONFIG.showPosters && d.posterId ? await getImage(`/Items/${d.posterId}/Images/Primary?maxHeight=180&quality=80`) : null,
      };
    })
  );
}

// ---------------------------------------------------------------------------

function progressBar(frac, width, color) {
  const h = 5;
  const ctx = new DrawContext();
  ctx.size = new Size(width, h);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const track = new Path();
  track.addRoundedRect(new Rect(0, 0, width, h), h / 2, h / 2);
  ctx.addPath(track);
  ctx.setFillColor(COLORS.track);
  ctx.fillPath();
  const w = Math.max(h, width * Math.max(0, Math.min(1, frac)));
  const bar = new Path();
  bar.addRoundedRect(new Rect(0, 0, w, h), h / 2, h / 2);
  ctx.addPath(bar);
  ctx.setFillColor(color);
  ctx.fillPath();
  return ctx.getImage();
}

function addSession(parent, s, opts) {
  const row = parent.addStack();
  row.centerAlignContent();

  if (s.poster && opts.poster) {
    const img = row.addImage(s.poster);
    img.imageSize = new Size(opts.posterH * 0.67, opts.posterH);
    img.cornerRadius = 4;
    row.addSpacer(8);
  }

  const col = row.addStack();
  col.layoutVertically();

  const t = col.addText(s.title);
  t.font = Font.boldSystemFont(opts.compact ? 12 : 13);
  t.textColor = COLORS.text;
  t.lineLimit = 1;

  if (s.subtitle) {
    const st = col.addText(s.subtitle);
    st.font = Font.systemFont(10);
    st.textColor = COLORS.sub;
    st.lineLimit = 1;
  }

  const u = col.addText(
    `👤 ${s.user}` + (opts.compact ? "" : `  ·  ${s.device}`) + (s.transcoding ? "  ·  transcode" : "")
  );
  u.font = Font.mediumSystemFont(10);
  u.textColor = COLORS.accent;
  u.lineLimit = 1;

  col.addSpacer(3);
  const frac = s.duration > 0 ? s.position / s.duration : 0;
  const bar = col.addImage(progressBar(frac, opts.barW, s.paused ? COLORS.paused : COLORS.accent));
  bar.imageSize = new Size(opts.barW, 5);
  col.addSpacer(2);

  // Tijden zoals in de player: verstreken links, totale duur rechts
  const times = col.addStack();
  times.size = new Size(opts.barW, 0);
  times.centerAlignContent();
  const timeFont = Font.mediumMonospacedSystemFont(10);
  if (s.paused) {
    const el = times.addText("⏸ " + fmtTime(s.position));
    el.font = timeFont;
    el.textColor = COLORS.paused;
  } else {
    // Live doorlopende timer: start = nu - positie
    const el = times.addDate(new Date(Date.now() - s.position * 1000));
    el.applyTimerStyle();
    el.font = timeFont;
    el.textColor = COLORS.text;
  }
  times.addSpacer();
  const tot = times.addText(s.duration > 0 ? fmtTime(s.duration) : "live");
  tot.font = timeFont;
  tot.textColor = COLORS.sub;
}

function buildWidget(state) {
  const w = new ListWidget();
  w.backgroundColor = COLORS.bg;
  w.setPadding(12, 14, 10, 14);
  w.refreshAfterDate = new Date(Date.now() + CONFIG.refreshMinutes * 60000);
  w.url = BASE + "/web/#/dashboard";

  const family = config.widgetFamily || "large";
  const max = { small: 1, medium: 2, large: 4 }[family] || 4;
  const compact = family === "small";
  const opts = {
    compact,
    poster: !compact && CONFIG.showPosters,
    posterH: family === "large" ? 62 : 50,
    barW: compact ? 130 : CONFIG.showPosters ? 225 : 290,
  };

  const head = w.addStack();
  head.centerAlignContent();
  const h = head.addText("Jellyfin");
  h.font = Font.boldSystemFont(13);
  h.textColor = COLORS.accent;
  head.addSpacer();
  const cnt = head.addText(state.error ? "offline" : state.sessions.length ? `▶ ${state.sessions.length}` : "");
  cnt.font = Font.semiboldSystemFont(11);
  cnt.textColor = state.error ? COLORS.err : COLORS.sub;
  w.addSpacer(8);

  if (state.error) {
    const x = w.addText(state.error);
    x.font = Font.systemFont(11);
    x.textColor = COLORS.err;
    x.lineLimit = 3;
  } else if (!state.sessions.length) {
    w.addSpacer();
    const x = w.addText("Er wordt niets afgespeeld");
    x.font = Font.systemFont(12);
    x.textColor = COLORS.sub;
    x.centerAlignText();
  } else {
    const shown = state.sessions.slice(0, max);
    shown.forEach((s, i) => {
      addSession(w, s, opts);
      if (i < shown.length - 1) w.addSpacer(family === "large" ? 10 : 8);
    });
    const more = state.sessions.length - shown.length;
    if (more > 0) {
      w.addSpacer(4);
      const m = w.addText(`+${more} meer`);
      m.font = Font.systemFont(10);
      m.textColor = COLORS.sub;
    }
  }
  w.addSpacer();
  return w;
}

async function showTable(state) {
  const table = new UITable();
  table.showSeparators = true;
  if (state.error) {
    const r = new UITableRow();
    r.addText("Offline", state.error);
    table.addRow(r);
  } else if (!state.sessions.length) {
    const r = new UITableRow();
    r.addText("Er wordt niets afgespeeld");
    table.addRow(r);
  }
  for (const s of state.sessions || []) {
    const r = new UITableRow();
    r.height = 80;
    if (s.poster) {
      const c = r.addImage(s.poster);
      c.widthWeight = 15;
    }
    const c2 = r.addText(
      `${s.paused ? "⏸ " : "▶ "}${s.title}`,
      `${s.subtitle}\n${s.user} · ${s.device}\n${fmtTime(s.position)} / ${fmtTime(s.duration)}${s.transcoding ? " · transcode" : ""}`
    );
    c2.widthWeight = 85;
    c2.subtitleFont = Font.systemFont(12);
    table.addRow(r);
  }
  await table.present();
}

let state;
try {
  state = { sessions: await loadSessions() };
} catch (e) {
  state = { sessions: [], error: String(e.message || e) };
}

if (config.runsInWidget) {
  Script.setWidget(buildWidget(state));
} else {
  await showTable(state);
}
Script.complete();
