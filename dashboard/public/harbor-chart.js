/**
 * Harbor sea chart (public/harbor-chart.js).
 *
 * A 16:7 pixel canvas at the top of the Harbor leaf, drawn from
 * GET /api/harbor/chart (dashboard/lib/harbor-chart.ts). No framework: plain
 * canvas + DOM. The model is 160×70 chart units; the canvas maps them onto an
 * 8 px grid, snapped to integer cells so the ink is crisp and pixelated.
 *
 * Motion: on a progress change the ships and waypoints tween from the last
 * frame over 600 ms in 6 steps, drawn on requestAnimationFrame only while
 * animating (so ~30 fps at most, and nothing runs when hidden). Under
 * `prefers-reduced-motion: reduce` positions snap and no animation loop runs.
 *
 * Interaction: hovering a ship or island shows a 1 px ink tooltip (goal,
 * progress, condition, crew); clicking a ship opens its deck through the same
 * path the tiles use. A visually hidden <ol> repeats the same facts, so the
 * canvas is an enhancement of the tile list, not a replacement.
 */

const CHART_W = 160;
const CHART_H = 70;
const WALL_CELLS = 2; // drydock strip along the left, in 8 px cells
const DURATION_MS = 600;
const STEPS = 6;

const CONDITION_LABEL = {
  "needs-you": "Needs you",
  storm: "Storm",
  becalmed: "Becalmed",
  blocked: "Blocked",
  headway: "Headway",
  docked: "Docked",
  yard: "In the yard",
};

const STATE_LABEL = { yard: "In the yard", docked: "Docked", sailing: "Under sail" };

// Six island tiles, 4×3 cells each: `.` empty, `#` sand, `g` green, `y` gold.
const ISLAND_TILES = [
  [".##.", "#gg#", "####"], // 0 green hill
  ["#..#", "####", "####"], // 1 twin sandbar
  [".###", "####", ".##."], // 2 round atoll
  ["#.##", "#gg#", "#y##"], // 3 hill with gold
  ["###.", "#g#.", "###."], // 4 hook
  [".#..", "###.", "#g##"], // 5 jagged
];

const state = {
  container: null,
  canvas: null,
  ctx: null,
  list: null,
  tooltip: null,
  ro: null,
  target: null, // latest model from the server
  from: null, // model the tween started from
  tween: null, // { start, raf, from, to, lastStep, pausedAt }
  refreshTimer: 0,
  cssWidth: 0,
  cssHeight: 0,
  cols: 0,
  rows: 0,
  dpr: 1,
  hits: [],
  reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  fontsReady: null,
};

function colors() {
  const s = getComputedStyle(document.documentElement);
  const v = (name, fb) => {
    const x = s.getPropertyValue(name).trim();
    return x || fb;
  };
  return {
    bone: v("--bone", "#f4efe4"),
    ink: v("--ink", "#1a1a1a"),
    quiet: v("--quiet", "#3d4a3a"),
    teal: v("--teal", "#0f6e68"),
    yellow: v("--yellow", "#8a6200"),
    vermilion: v("--vermilion", "#9c1230"),
    sheet: v("--sheet", "#fffaf2"),
    sea: v("--sea", "#cfe3dc"),
    seaDeep: v("--sea-deep", "#2f6f7a"),
    seaDeeper: v("--sea-deeper", "#3a8590"),
    drydock: v("--drydock", "#e8dcc2"),
    drydockRail: v("--drydock-deep", "#8a6a3e"),
    hull: v("--hull", "#6b3f1f"),
    hullDark: v("--hull-dark", "#4a2a14"),
  };
}

function statusColor(c, status) {
  if (status === "done") return c.teal;
  if (status === "working") return c.yellow;
  if (status === "blocked") return c.vermilion;
  return c.quiet;
}

function ensureFonts() {
  if (!state.fontsReady && document.fonts && document.fonts.load) {
    state.fontsReady = document.fonts.load("8px Silkscreen").catch(() => {});
  }
  return state.fontsReady || Promise.resolve();
}

// ------------------------------------------------------------ geometry

function layout() {
  const w = state.container ? state.container.clientWidth : 0;
  state.dpr = window.devicePixelRatio || 1;
  state.cssWidth = Math.max(8 * 8, Math.floor(w / 8) * 8);
  state.cssHeight = Math.max(3 * 8, Math.round((state.cssWidth * 7) / 16 / 8) * 8);
  state.cols = Math.round(state.cssWidth / 8);
  state.rows = Math.round(state.cssHeight / 8);
  const c = state.canvas;
  c.style.width = `${state.cssWidth}px`;
  c.style.height = `${state.cssHeight}px`;
  c.width = Math.round(state.cssWidth * state.dpr);
  c.height = Math.round(state.cssHeight * state.dpr);
  const ctx = state.ctx;
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
}

/** Chart x (0..160) → CSS px, snapped to the 8 px grid, inside the water area. */
function gx(x) {
  const cell = (x / CHART_W) * (state.cols - WALL_CELLS);
  return (WALL_CELLS + Math.round(cell)) * 8;
}

/** Chart y (0..70) → CSS px, snapped to the 8 px grid. */
function gy(y) {
  return Math.round((y / CHART_H) * state.rows) * 8;
}

function lerpPoint(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** A model with ship positions and waypoints interpolated between two frames. */
function interpolated(from, to, t) {
  if (!from) return to;
  const ships = to.ships.map((s) => {
    const f = from.ships.find((x) => x.id === s.id) || s;
    const waypoints = s.waypoints.map((w, j) => {
      const fw = f.waypoints[j] || w;
      return { ...w, x: fw.x + (w.x - fw.x) * t, y: fw.y + (w.y - fw.y) * t };
    });
    return { ...s, position: lerpPoint(f.position || f.berthPos, s.position, t), waypoints };
  });
  return { ...to, ships };
}

// ------------------------------------------------------------ drawing

function drawWater(c) {
  const ctx = state.ctx;
  const waterX = WALL_CELLS * 8;
  const waterW = state.cssWidth - waterX;
  ctx.fillStyle = c.sea;
  ctx.fillRect(waterX, 0, waterW, state.cssHeight);
  // Wave stripes: two sea blues alternating every 8 px.
  for (let y = 0; y < state.rows; y += 2) {
    ctx.fillStyle = c.seaDeep;
    ctx.fillRect(waterX, y * 8, waterW, 1);
    if (y + 1 < state.rows) {
      ctx.fillStyle = c.seaDeeper;
      ctx.fillRect(waterX, (y + 1) * 8, waterW, 1);
    }
  }
}

function drawHarbor(c, model) {
  const ctx = state.ctx;
  // Drydock strip along the left edge.
  ctx.fillStyle = c.drydock;
  ctx.fillRect(0, 0, WALL_CELLS * 8, state.cssHeight);
  // Waterline.
  ctx.fillStyle = c.ink;
  ctx.fillRect(WALL_CELLS * 8, 0, 1, state.cssHeight);
  // Berth cleats along the waterline.
  for (const s of model.ships) {
    const y = gy(s.berthPos.y);
    ctx.fillStyle = c.ink;
    ctx.fillRect(WALL_CELLS * 8 - 2, y - 2, 4, 4);
  }
}

function drawRoute(c, s) {
  const ctx = state.ctx;
  const from = { x: gx(0), y: gy(s.berthPos.y) };
  const to = { x: gx(s.island.x), y: gy(s.island.y) };
  ctx.save();
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = 1;
  ctx.setLineDash([8, 4]);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();
}

function drawWaypoint(c, w) {
  const ctx = state.ctx;
  const x = gx(w.x);
  const y = gy(w.y);
  const color = statusColor(c, w.status);
  const thick = w.kind === "maneuver";
  const s = thick ? 8 : 4;
  const x0 = x - s / 2;
  const y0 = y - s / 2;
  ctx.lineWidth = 1;
  if (w.status === "done") {
    ctx.fillStyle = color;
    ctx.fillRect(x0, y0, s, s);
  } else if (w.status === "working") {
    ctx.strokeStyle = color;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, s - 1, s - 1);
  } else if (w.status === "blocked") {
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + s, y0 + s);
    ctx.moveTo(x0 + s, y0);
    ctx.lineTo(x0, y0 + s);
    ctx.stroke();
  } else {
    // open: a dot
    ctx.fillStyle = color;
    ctx.fillRect(x - 1, y - 1, 2, 2);
  }
  // Maneuver ticks are thicker and carry phase sub-dashes (pass|ok|done / total).
  if (thick) {
    const filled = Math.max(0, Math.min(4, Math.round(w.phase * 4)));
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i < filled ? c.teal : c.quiet;
      ctx.fillRect(x0 + i * 2, y0 + s + 2, 2, 1);
    }
  }
}

function drawIsland(c, s) {
  const ctx = state.ctx;
  const tile = ISLAND_TILES[s.island.shape % ISLAND_TILES.length];
  const h = tile.length;
  const w = tile[0].length;
  const x0 = gx(s.island.x) - (w * 8) / 2;
  const y0 = gy(s.island.y) - (h * 8) / 2;
  for (let r = 0; r < h; r++) {
    for (let col = 0; col < w; col++) {
      const ch = tile[r][col];
      if (ch === ".") continue;
      ctx.fillStyle = ch === "g" ? c.teal : ch === "y" ? c.yellow : c.bone;
      ctx.fillRect(x0 + col * 8, y0 + r * 8, 8, 8);
      ctx.fillStyle = c.ink;
      if (r === 0 || tile[r - 1][col] === ".") ctx.fillRect(x0 + col * 8, y0 + r * 8, 8, 1);
      if (r === h - 1 || tile[r + 1][col] === ".") ctx.fillRect(x0 + col * 8, y0 + r * 8 + 7, 8, 1);
      if (col === 0 || tile[r][col - 1] === ".") ctx.fillRect(x0 + col * 8, y0 + r * 8, 1, 8);
      if (col === w - 1 || tile[r][col + 1] === ".") ctx.fillRect(x0 + col * 8 + 7, y0 + r * 8, 1, 8);
    }
  }
  // Label: voyage goal, first 10 chars, under the island.
  const label = (s.voyage?.label || "").slice(0, 10).toUpperCase();
  if (label) {
    ctx.save();
    ctx.font = "8px Silkscreen, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = c.ink;
    ctx.fillText(label, gx(s.island.x), y0 + h * 8 + 2);
    ctx.restore();
  }
  state.hits.push({ kind: "island", ship: s, x: gx(s.island.x), y: gy(s.island.y), r: Math.max(12, (Math.max(w, h) * 8) / 2 + 4) });
}

function drawHull(c, x, y) {
  const ctx = state.ctx;
  ctx.fillStyle = c.hull;
  ctx.beginPath();
  ctx.moveTo(x - 8, y - 3);
  ctx.lineTo(x + 8, y - 3);
  ctx.lineTo(x + 5, y + 1);
  ctx.lineTo(x - 5, y + 1);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = c.hullDark;
  ctx.fillRect(x - 5, y - 1, 10, 2);
}

function drawSail(c, x, y, height) {
  if (height <= 0) return;
  const ctx = state.ctx;
  const apex = y - 3 - height;
  // Mast behind the sail.
  ctx.fillStyle = c.ink;
  ctx.fillRect(x - 1, apex, 1, y + 1 - apex);
  // Sail: a right triangle left of the mast.
  ctx.fillStyle = c.sheet;
  ctx.beginPath();
  ctx.moveTo(x, apex);
  ctx.lineTo(x - 6, y - 3);
  ctx.lineTo(x, y - 3);
  ctx.closePath();
  ctx.fill();
  // Boom.
  ctx.fillStyle = c.ink;
  ctx.fillRect(x - 6, y - 3, 6, 1);
}

function drawWake(c, s, x, y) {
  if (s.progress <= 0.04) return;
  const ctx = state.ctx;
  const bx = gx(0);
  const by = gy(s.berthPos.y);
  const dx = x - bx;
  const dy = y - by;
  const len = Math.hypot(dx, dy);
  if (len < 2) return;
  const ux = dx / len;
  const uy = dy / len;
  ctx.fillStyle = c.sheet;
  for (let d = 4; d < len; d += 8) {
    ctx.fillRect(Math.round(x - ux * d) - 2, Math.round(y - uy * d) + 2, 4, 2);
  }
}

function drawShip(c, s) {
  let x;
  let y;
  let sailHeight;
  if (s.state === "yard") {
    // Drydock: hull resting on a rail above the waterline.
    x = (WALL_CELLS * 8) / 2;
    y = gy(s.berthPos.y);
    const ctx = state.ctx;
    ctx.fillStyle = c.drydockRail;
    ctx.fillRect(2, y + 1, WALL_CELLS * 8 - 4, 2);
    drawHull(c, x, y);
    sailHeight = 0;
  } else if (s.state === "docked") {
    x = gx(0);
    y = gy(s.berthPos.y);
    drawHull(c, x, y);
    sailHeight = 4;
  } else {
    x = gx(s.position.x);
    y = gy(s.position.y);
    drawWake(c, s, x, y);
    drawHull(c, x, y);
    sailHeight = 9;
  }
  drawSail(c, x, y, sailHeight);
  state.hits.push({ kind: "ship", ship: s, x, y, r: 10 });
}

function draw(model) {
  if (!state.ctx || !model) return;
  if (!state.container.clientWidth || document.hidden) return;
  const c = colors();
  const ctx = state.ctx;
  ctx.clearRect(0, 0, state.cssWidth, state.cssHeight);
  state.hits = [];
  drawWater(c);
  drawHarbor(c, model);
  // Routes first (they end under the island), then islands, then waypoint
  // ticks on top so the last tick (at the island) stays visible, ships last.
  for (const s of model.ships) {
    if (s.voyage && s.island) drawRoute(c, s);
  }
  for (const s of model.ships) if (s.island) drawIsland(c, s);
  for (const s of model.ships) {
    if (s.voyage && s.island) {
      for (const w of s.waypoints) drawWaypoint(c, w);
    }
  }
  for (const s of model.ships) drawShip(c, s);
  buildList(model);
}

function redraw() {
  state.tween = null;
  state.from = null;
  draw(state.target);
}

// ------------------------------------------------------------ the list

function crewText(s) {
  const parts = (s.crew || []).slice(0, 6).map((c) => `${c.id} (${c.status})`);
  return parts.length ? parts.join(", ") : "no crew aboard";
}

function shipText(s) {
  const pct = Math.round(s.progress * 100);
  const bits = [
    `${s.id}: ${STATE_LABEL[s.state] || s.state}, ${CONDITION_LABEL[s.condition] || s.condition}, ${pct}% done.`,
    s.voyage ? `Voyage: ${s.voyage.goal}.` : "",
    `Crew: ${crewText(s)}.`,
  ];
  return bits.filter(Boolean).join(" ");
}

function buildList(model) {
  if (!state.list) return;
  if (state.list.dataset.text === JSON.stringify(model.ships.map((s) => s.id + s.progress))) return;
  state.list.dataset.text = JSON.stringify(model.ships.map((s) => s.id + s.progress));
  state.list.textContent = "";
  for (const s of model.ships) {
    const li = document.createElement("li");
    li.textContent = shipText(s);
    state.list.appendChild(li);
  }
}

// ------------------------------------------------------------ tooltip

function hitAt(x, y) {
  let best = null;
  let bestD = 1e9;
  for (const h of state.hits) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d <= h.r && d < bestD) {
      best = h;
      bestD = d;
    }
  }
  return best;
}

function tipText(hit) {
  const s = hit.ship;
  const pct = Math.round(s.progress * 100);
  const head = `${s.id} — ${STATE_LABEL[s.state] || s.state} · ${CONDITION_LABEL[s.condition] || s.condition} · ${pct}%`;
  const lines = [head];
  if (s.voyage) lines.push(s.voyage.goal);
  lines.push(`Crew: ${crewText(s)}`);
  return lines.join("\n");
}

function showTip(hit, x, y) {
  const t = state.tooltip;
  t.textContent = tipText(hit);
  t.hidden = false;
  const pad = 12;
  let left = x + pad;
  let top = y + pad;
  // Keep it inside the chart; measure after showing.
  const maxX = state.container.clientWidth - t.offsetWidth - 4;
  const maxY = state.container.clientHeight - t.offsetHeight - 4;
  if (left > maxX) left = Math.max(4, x - t.offsetWidth - pad);
  if (top > maxY) top = Math.max(4, y - t.offsetHeight - pad);
  t.style.left = `${Math.round(left)}px`;
  t.style.top = `${Math.round(top)}px`;
}

function hideTip() {
  if (state.tooltip) state.tooltip.hidden = true;
}

function onMove(ev) {
  const hit = hitAt(ev.offsetX, ev.offsetY);
  if (hit) showTip(hit, ev.offsetX, ev.offsetY);
  else hideTip();
}

function onClick(ev) {
  const hit = hitAt(ev.offsetX, ev.offsetY);
  if (hit && hit.kind === "ship") openDeck(hit.ship.id);
}

function openDeck(id) {
  // Same navigation the tiles use: Alpine's openShip (in-place), with a full-page fallback.
  const app = window.Alpine && Alpine.$data(document.body);
  if (app && typeof app.openShip === "function") {
    app.openShip(id);
    return;
  }
  location.href = `/ships/${encodeURIComponent(id)}`;
}

// ------------------------------------------------------------ tween

function startTween() {
  if (state.reduced || !state.from || !state.target) {
    state.from = null;
    draw(state.target);
    return;
  }
  cancelAnimationFrame(state.tween?.raf);
  const from = state.from;
  const to = state.target;
  state.tween = { start: performance.now(), raf: 0, from, to, lastStep: -1, pausedAt: 0 };
  state.tween.raf = requestAnimationFrame(step);
}

function step(now) {
  const t = state.tween;
  if (!t || state.reduced) return;
  const elapsed = now - t.start;
  const prog = Math.min(1, elapsed / DURATION_MS);
  const k = Math.floor(prog * STEPS);
  if (k !== t.lastStep) {
    t.lastStep = k;
    draw(interpolated(t.from, t.to, k / STEPS));
  }
  if (elapsed < DURATION_MS) {
    t.raf = requestAnimationFrame(step);
  } else {
    state.tween = null;
    state.from = null;
    draw(state.target);
  }
}

function onVisibility() {
  if (document.hidden) {
    if (state.tween) {
      cancelAnimationFrame(state.tween.raf);
      state.tween.pausedAt = performance.now();
    }
  } else if (state.tween && state.tween.pausedAt) {
    state.tween.start += performance.now() - state.tween.pausedAt;
    state.tween.pausedAt = 0;
    state.tween.raf = requestAnimationFrame(step);
  } else {
    draw(state.target);
  }
}

// ------------------------------------------------------------ fetch

function refreshSoon() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(refresh, 300);
}

async function refresh() {
  clearTimeout(state.refreshTimer);
  try {
    const r = await fetch("/api/harbor/chart", { headers: { accept: "application/json" } });
    if (!r.ok) return;
    const j = await r.json();
    await ensureFonts();
    setTarget(j);
  } catch {
    /* keep the last frame */
  }
}

function setTarget(j) {
  const next = j && Array.isArray(j.ships) ? j : null;
  if (!next) return;
  const prev = state.target;
  if (!prev) {
    state.target = next;
    state.from = null;
    draw(next);
    return;
  }
  const moved = next.ships.some((s, i) => {
    const f = prev.ships[i];
    return f && (f.progress !== s.progress || f.position.x !== s.position.x || f.position.y !== s.position.y);
  });
  state.from = prev;
  state.target = next;
  if (moved && !state.reduced && state.container.clientWidth) startTween();
  else {
    state.from = null;
    draw(next);
  }
}

function ensureSize() {
  layout();
  draw(state.target);
}

// ------------------------------------------------------------ mount

function mount(container) {
  if (!container || state.container === container) return;
  state.container = container;
  container.replaceChildren();
  state.canvas = document.createElement("canvas");
  state.canvas.setAttribute("role", "img");
  state.canvas.setAttribute("aria-label", "Harbor chart");
  state.canvas.className = "sea-chart-canvas";
  container.appendChild(state.canvas);
  state.tooltip = document.createElement("div");
  state.tooltip.className = "sea-chart-tip";
  state.tooltip.hidden = true;
  container.appendChild(state.tooltip);
  state.list = document.createElement("ol");
  state.list.className = "sr-only";
  container.appendChild(state.list);
  state.ctx = state.canvas.getContext("2d");
  state.canvas.addEventListener("mousemove", onMove);
  state.canvas.addEventListener("mouseleave", hideTip);
  state.canvas.addEventListener("click", onClick);
  if (window.ResizeObserver) {
    state.ro = new ResizeObserver(() => {
      layout();
      draw(state.target);
    });
    state.ro.observe(container);
  }
  document.addEventListener("visibilitychange", onVisibility);
  window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", (e) => {
    state.reduced = e.matches;
    if (state.reduced) redraw();
  });
  layout();
  refresh();
}

function init() {
  const el = document.getElementById("sea-chart");
  if (el) mount(el);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();

// app.js drives the refetch on the existing SSE ship/agents events and the leaf resize.
window.SeaChart = { mount, refresh, refreshSoon, ensureSize, setTarget };
