/**
 * Harbor sea chart (public/harbor-chart.js).
 *
 * A 16:7 pixel canvas at the top of the Harbor leaf, drawn from
 * GET /api/harbor/chart (dashboard/lib/harbor-chart.ts). No framework: plain
 * canvas + DOM. The model is 160×70 chart units; positions map onto an 8 px
 * grid, and sprites, ticks, islands and text draw on a width-scaled sprite
 * cell (≥8 px, a multiple of 8) so they stay legible as the canvas grows.
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
const WALL_CELLS = 3; // drydock strip along the left, in sprite cells
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
  rows: 0,
  dpr: 1,
  cell: 8, // sprite cell in CSS px, scaled with the canvas and snapped to 8
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
  state.rows = Math.round(state.cssHeight / 8);
  // One sprite cell, scaled with the canvas and snapped to a multiple of 8.
  state.cell = Math.max(8, Math.round(state.cssWidth / (CHART_W * 8)) * 8);
  const c = state.canvas;
  c.style.width = `${state.cssWidth}px`;
  c.style.height = `${state.cssHeight}px`;
  c.width = Math.round(state.cssWidth * state.dpr);
  c.height = Math.round(state.cssHeight * state.dpr);
  const ctx = state.ctx;
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
}

/** The drydock strip width in px (2 sprite cells). */
function wallPx() {
  return WALL_CELLS * state.cell;
}

/** Chart x (0..160) → CSS px, snapped to the 8 px grid, inside the water area. */
function gx(x) {
  const waterW = state.cssWidth - wallPx();
  const cols = Math.round(waterW / 8);
  return wallPx() + Math.round((x / CHART_W) * cols) * 8;
}

/** Chart y (0..70) → CSS px, snapped to the 8 px grid. */
function gy(y) {
  return Math.round((y / CHART_H) * state.rows) * 8;
}

/** Label font scaled with the cell, floored at 10 px so it stays readable. */
function labelFont() {
  return `${Math.max(10, Math.round(state.cell * 0.9))}px Silkscreen, sans-serif`;
}

function hullTop() {
  return Math.round(state.cell * 0.75);
}

function hullBot() {
  return Math.round(state.cell * 0.25);
}

function berthLabel(s) {
  return (s.id || "").toUpperCase();
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
  const waterX = wallPx();
  const waterW = state.cssWidth - waterX;
  // Flat sea with a calm stripe band (not per-row scanlines).
  ctx.fillStyle = c.sea;
  ctx.fillRect(waterX, 0, waterW, state.cssHeight);
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = c.seaDeep;
  for (let yy = state.cell; yy < state.cssHeight; yy += state.cell * 2) {
    ctx.fillRect(waterX, yy, waterW, state.cell);
  }
  ctx.globalAlpha = 1;
}

function drawHarbor(c, model) {
  const ctx = state.ctx;
  const wall = wallPx();
  const cell = state.cell;
  // Drydock strip: timber deck with a rail per berth so it reads as a drydock.
  ctx.fillStyle = c.drydock;
  ctx.fillRect(0, 0, wall, state.cssHeight);
  // Waterline between the dock and the sea.
  ctx.fillStyle = c.ink;
  ctx.fillRect(wall - 1, 0, 1, state.cssHeight);
  for (const s of model.ships) {
    const y = gy(s.berthPos.y);
    // A drydock cradle: two rails the yard hull sits between, plus a cleat.
    ctx.fillStyle = c.drydockRail;
    const railH = Math.max(3, Math.round(cell / 2));
    ctx.fillRect(2, y - hullTop(), wall - 4, railH);
    ctx.fillRect(2, y + hullBot(), wall - 4, railH);
    ctx.fillStyle = c.ink;
    ctx.fillRect(wall - 2, y - 2, 4, 4);
    // Berth label: the ship id just off the cleat.
    ctx.save();
    ctx.font = labelFont();
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = c.ink;
    ctx.fillText(berthLabel(s), wall + Math.round(cell / 2), y - Math.round(cell * 0.75));
    ctx.restore();
  }
}

/** The sailing ship furthest along its voyage leads; its route reads in ink. */
function activeShipId(model) {
  let best = null;
  let bestP = -1;
  for (const s of model.ships) {
    if (s.voyage && s.island && s.progress > bestP) {
      best = s.id;
      bestP = s.progress;
    }
  }
  return best;
}

function drawRoute(c, s, active) {
  const ctx = state.ctx;
  const cell = state.cell;
  const from = { x: gx(0), y: gy(s.berthPos.y) };
  const to = { x: gx(s.island.x), y: gy(s.island.y) };
  ctx.save();
  ctx.strokeStyle = c.ink;
  // The active route reads in ink; the rest draw lighter so crossings separate.
  ctx.globalAlpha = active ? 1 : 0.45;
  ctx.lineWidth = Math.max(2, Math.round(cell / 4));
  ctx.setLineDash([cell * 2, cell]);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();
}

function drawWaypoint(c, w) {
  const ctx = state.ctx;
  const cell = state.cell;
  const x = gx(w.x);
  const y = gy(w.y);
  const color = statusColor(c, w.status);
  const s = cell * 2; // at least 2×2 cells
  const x0 = x - s / 2;
  const y0 = y - s / 2;
  // Ink border first so done/working/blocked/open read against the sea.
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = 1;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, s - 1, s - 1);
  if (w.status === "done") {
    ctx.fillStyle = color;
    ctx.fillRect(x0 + 2, y0 + 2, s - 4, s - 4);
  } else if (w.status === "working") {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, Math.round(cell / 4));
    ctx.strokeRect(x0 + 2.5, y0 + 2.5, s - 5, s - 5);
  } else if (w.status === "blocked") {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, Math.round(cell / 4));
    ctx.beginPath();
    ctx.moveTo(x0 + 2, y0 + 2);
    ctx.lineTo(x0 + s - 2, y0 + s - 2);
    ctx.moveTo(x0 + s - 2, y0 + 2);
    ctx.lineTo(x0 + 2, y0 + s - 2);
    ctx.stroke();
  } else {
    // open: a dot in the middle of the box
    const d = Math.max(2, Math.round(cell / 4));
    ctx.fillStyle = color;
    ctx.fillRect(x - d / 2, y - d / 2, d, d);
  }
  // Maneuver ticks carry phase sub-dashes (pass|ok|done / total).
  if (w.kind === "maneuver") {
    const filled = Math.max(0, Math.min(4, Math.round(w.phase * 4)));
    const dw = Math.max(2, Math.round(cell / 2));
    const dh = Math.max(1, Math.round(cell / 4));
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i < filled ? c.teal : c.quiet;
      ctx.fillRect(x0 + i * Math.round(cell / 2), y0 + s + Math.round(cell / 4), dw - 1, dh);
    }
  }
}

function drawIsland(c, s) {
  const ctx = state.ctx;
  const cell = state.cell;
  const tile = ISLAND_TILES[s.island.shape % ISLAND_TILES.length];
  const h = tile.length;
  const w = tile[0].length;
  const x0 = gx(s.island.x) - (w * cell) / 2;
  const y0 = gy(s.island.y) - (h * cell) / 2;
  for (let r = 0; r < h; r++) {
    for (let col = 0; col < w; col++) {
      const ch = tile[r][col];
      if (ch === ".") continue;
      ctx.fillStyle = ch === "g" ? c.teal : ch === "y" ? c.yellow : c.bone;
      ctx.fillRect(x0 + col * cell, y0 + r * cell, cell, cell);
      ctx.fillStyle = c.ink;
      if (r === 0 || tile[r - 1][col] === ".") ctx.fillRect(x0 + col * cell, y0 + r * cell, cell, 1);
      if (r === h - 1 || tile[r + 1][col] === ".") ctx.fillRect(x0 + col * cell, y0 + r * cell + cell - 1, cell, 1);
      if (col === 0 || tile[r][col - 1] === ".") ctx.fillRect(x0 + col * cell, y0 + r * cell, 1, cell);
      if (col === w - 1 || tile[r][col + 1] === ".") ctx.fillRect(x0 + col * cell + cell - 1, y0 + r * cell, 1, cell);
    }
  }
  // Label: voyage goal, first 10 chars, under the island.
  const label = (s.voyage?.label || "").slice(0, 10).toUpperCase();
  if (label) {
    ctx.save();
    ctx.font = labelFont();
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = c.ink;
    ctx.fillText(label, gx(s.island.x), y0 + h * cell + Math.max(2, Math.round(cell / 4)));
    ctx.restore();
  }
  state.hits.push({ kind: "island", ship: s, x: gx(s.island.x), y: gy(s.island.y), r: Math.max(cell * 1.5, (Math.max(w, h) * cell) / 2 + Math.round(cell / 2)) });
}

function drawHull(c, x, y, w, insetTop = 0) {
  const ctx = state.ctx;
  const half = w / 2;
  const topY = y - hullTop() + insetTop;
  const botY = y + hullBot();
  const botHalf = Math.max(1, Math.round(half * 0.6));
  ctx.fillStyle = c.hull;
  ctx.beginPath();
  ctx.moveTo(x - half, topY);
  ctx.lineTo(x + half, topY);
  ctx.lineTo(x + botHalf, botY);
  ctx.lineTo(x - botHalf, botY);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = c.hullDark;
  const stripeH = Math.max(2, Math.round(state.cell / 4));
  ctx.fillRect(x - half, botY - stripeH, w, stripeH);
}

function drawSail(c, x, y, height) {
  if (height <= 0) return;
  const ctx = state.ctx;
  const cell = state.cell;
  const topY = y - hullTop();
  const apex = topY - height;
  const sailW = Math.max(cell, Math.round(cell * 1.25));
  const mastW = Math.max(1, Math.round(cell / 8));
  // Mast behind the sail.
  ctx.fillStyle = c.ink;
  ctx.fillRect(x - Math.round(mastW / 2), apex, mastW, topY + 1 - apex);
  // Sail: a right triangle left of the mast.
  ctx.fillStyle = c.sheet;
  ctx.beginPath();
  ctx.moveTo(x, apex);
  ctx.lineTo(x - sailW, topY);
  ctx.lineTo(x, topY);
  ctx.closePath();
  ctx.fill();
  // Boom.
  ctx.fillStyle = c.ink;
  ctx.fillRect(x - sailW, topY, sailW, mastW);
}

function drawWake(c, s, x, y) {
  if (s.progress <= 0.04) return;
  const ctx = state.ctx;
  const cell = state.cell;
  const bx = gx(0);
  const by = gy(s.berthPos.y);
  const dx = x - bx;
  const dy = y - by;
  const len = Math.hypot(dx, dy);
  if (len < cell) return;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const off = Math.round(cell * 0.75); // below the route, clear of the ink dashes
  const dashW = Math.max(2, Math.round(cell / 2));
  const dashH = Math.max(2, Math.round(cell / 3));
  ctx.fillStyle = c.sheet;
  for (let d = cell; d < len; d += cell + dashW) {
    const px = x - ux * d + nx * off;
    const py = y - uy * d + ny * off;
    ctx.fillRect(Math.round(px) - Math.round(dashW / 2), Math.round(py) - Math.round(dashH / 2), dashW, dashH);
  }
}

function drawShip(c, s) {
  const cell = state.cell;
  const wall = wallPx();
  let x;
  let y;
  let hullW;
  let sailHeight;
  if (s.state === "yard") {
    // Drydock: hull inset between the two cradle rails so both stay visible.
    x = wall / 2;
    y = gy(s.berthPos.y);
    hullW = Math.max(cell, wall - 8);
    drawHull(c, x, y, hullW, Math.max(2, Math.round(cell / 4)));
    sailHeight = 0;
  } else if (s.state === "docked") {
    x = gx(0);
    y = gy(s.berthPos.y);
    hullW = cell * 2;
    drawHull(c, x, y, hullW);
    sailHeight = cell;
  } else {
    x = gx(s.position.x);
    y = gy(s.position.y);
    hullW = cell * 3;
    drawWake(c, s, x, y);
    drawHull(c, x, y, hullW);
    sailHeight = cell * 2;
  }
  drawSail(c, x, y, sailHeight);
  state.hits.push({ kind: "ship", ship: s, x, y, r: Math.max(cell, hullW / 2 + Math.round(cell / 2)) });
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
  const activeId = activeShipId(model);
  for (const s of model.ships) {
    if (s.voyage && s.island) drawRoute(c, s, s.id === activeId);
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
    // A real link: reachable by keyboard, opens the deck in place with the href as a fallback.
    const a = document.createElement("a");
    a.href = `/ships/${encodeURIComponent(s.id)}`;
    a.textContent = shipText(s);
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      openDeck(s.id);
    });
    li.appendChild(a);
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
