const LOG_MAX = 80;
/** Said after the spoken gist of a long or structured reply. */
const REST_ON_SCREEN = "The rest is on screen.";
/** Spoken the moment a voice message goes out, so the agent answers at once (rotated, never twice in a row). */
const ACK_LINES = {
  alice: ["Aye, Captain.", "One sec.", "On it.", "Right away, Captain.", "Let me look.", "Aye aye."],
  default: ["On it.", "One moment.", "Got it.", "Looking now."],
};
const CHAT_KEY = "fleet.chatId";

function readChatId() {
  try {
    return localStorage.getItem(CHAT_KEY) || "alice";
  } catch {
    return "alice";
  }
}

const LEAVES = ["needs", "harbor", "health", "agents"];
/** Health's sub-tabs; each has its own URL (/health/metrics). */
const HEALTH_TABS = [
  { id: "status", label: "Status" },
  { id: "usage", label: "Usage" },
  { id: "metrics", label: "Metrics" },
  { id: "diagnostics", label: "Diagnostics" },
];

/** Float32 chunks at `rate` → 16 kHz mono 16-bit WAV (what the transcriber wants). */
function encodeWav16k(chunks, rate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const ratio = rate / 16000;
  const outLen = Math.floor(total / ratio);
  const pcm = new Int16Array(outLen);
  let ci = 0, off = 0, acc = 0, count = 0, o = 0, next = ratio;
  for (let i = 0; i < total && o < outLen; i++) {
    const v = chunks[ci][off];
    acc += v;
    count++;
    if (i + 1 >= next) {
      const s = Math.max(-1, Math.min(1, acc / count));
      pcm[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      acc = 0;
      count = 0;
      next += ratio;
    }
    if (++off >= chunks[ci].length) {
      ci++;
      off = 0;
    }
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(buf);
  const str = (p, s) => [...s].forEach((ch, k) => dv.setUint8(p + k, ch.charCodeAt(0)));
  str(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, "data"); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}

function saveChatId(id) {
  try {
    localStorage.setItem(CHAT_KEY, id);
  } catch {
    /* private mode */
  }
}

function dashboardApp() {
  return {
    leaf: "harbor",
    /** Ship shown on the harbor leaf (/ships/<id>), or "" for the harbor itself. */
    shipSel: "",
    hinge: "",
    paletteOpen: false,
    paletteIndex: 0,
    waiting: false,
    waitSummary: "",
    /** Everything waiting on the captain (/api/needs-you): questions, holds, failed sends. */
    needs: [],
    /** Quiet hours: Snooze holds interruptions; Wake ends it with a digest of what was held. */
    quiet: { snoozed: false, held: 0 },
    /** Phone push on this device: "unsupported" | "off" | "on" | "denied" | "busy". */
    push: "unsupported",
    bus: null,

    rail: { agents: [], workers: [] },
    chatOpen: false,
    chatId: readChatId(),
    chatEmpty: true,
    chatDraft: "",
    /** Voice: "idle" | "listening" | "transcribing"; replies are spoken when voiceReplies is on. */
    voiceState: "idle",
    voiceReplies: false,
    /** Show agents' thinking: narration between tool calls and the live "writing" text (per device, off by default). */
    showThinking: false,
    voiceSpeaking: false,
    voiceNote: "",
    /** The reply being spoken as it streams: {tid, raw, next (chars spoken), muted (barged in)}. */
    liveSpeech: null,
    chatConn: "",
    chatThinking: false,
    chatActivity: "",
    canvasItems: [],
    canvasSel: "",
    canvasOpen: false,
    /** A canvas item landed that the captain has not looked at (shown on the button where the canvas does not auto-open). */
    canvasFresh: false,
    /** At 1200px and up chat is a side column beside the page, not a full-screen drawer. */
    wide: false,
    chatWs: null,
    chatSockets: {},
    chatGen: 0,
    groups: [],
    chatGroup: null,
    groupTo: "",
    autoRoute: false,
    routing: false,
    routeNote: "",
    routeChoices: [],

    paletteItems() {
      const base = [
        { id: "needs", label: `Go to Needs you (${this.needs.length})`, run: () => this.openLeaf("needs") },
        { id: "harbor", label: "Go to Harbor", run: () => this.openLeaf("harbor") },
        { id: "health", label: "Go to Health", run: () => this.openLeaf("health") },
        { id: "agents", label: "Go to Agents", run: () => this.openLeaf("agents") },
      ];
      const chats = this.rail.agents
        .concat(this.rail.workers)
        .map((t) => ({ id: "chat-" + t.id, label: "Chat with " + t.label, run: () => this.openChat(t.id) }));
      const groupItems = this.groups.map((g) => ({ id: "group-" + g.id, label: "Open group " + g.name, run: () => this.openGroup(g.id) }));
      return base.concat(chats, groupItems, this.chatOpen ? [{ id: "chat-close", label: "Close chat", run: () => this.closeChat() }] : []);
    },

    /** Phone app (D6): the service worker, and whether this device gets push notifications. */
    async initPush() {
      if (!("serviceWorker" in navigator)) return;
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        if (!("PushManager" in window) || !("Notification" in window)) return;
        if (Notification.permission === "denied") return void (this.push = "denied");
        const sub = await reg.pushManager.getSubscription();
        this.push = sub ? "on" : "off";
        // Re-register on every load: the server drops a device the push service reports gone.
        if (sub) fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sub: sub.toJSON(), label: this.deviceLabel() }) });
      } catch {
        /* not a secure origin (plain http on another host): no app features */
      }
    },

    deviceLabel() {
      return /iPhone|iPad|Android/.test(navigator.userAgent) ? "phone" : "desktop";
    },

    async togglePush() {
      if (this.push === "busy" || this.push === "unsupported") return;
      const was = this.push;
      this.push = "busy";
      try {
        const reg = await navigator.serviceWorker.ready;
        const cur = await reg.pushManager.getSubscription();
        if (was === "on" && cur) {
          await fetch("/api/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: cur.endpoint }) });
          await cur.unsubscribe();
          this.push = "off";
          return;
        }
        if ((await Notification.requestPermission()) !== "granted") return void (this.push = "denied");
        const { publicKey } = await (await fetch("/api/push/key")).json();
        const raw = atob(publicKey.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (publicKey.length % 4)) % 4));
        const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
        // Always a fresh subscription: an old one may have expired at the push service.
        if (cur) await cur.unsubscribe().catch(() => {});
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        const r = await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sub: sub.toJSON(), label: this.deviceLabel() }) });
        if (!r.ok) throw new Error("subscribe failed");
        this.push = "on";
        fetch("/api/push/test", { method: "POST" });
      } catch {
        this.push = was;
      }
    },

    init() {
      try {
        this.voiceReplies = localStorage.getItem("fleet.voiceReplies") === "1";
        this.showThinking = localStorage.getItem("fleet.showThinking") === "1";
      } catch {
        /* private window */
      }
      this.voiceSince = Date.now();
      const wideQuery = window.matchMedia("(min-width: 1200px)");
      this.wide = wideQuery.matches;
      wideQuery.addEventListener("change", (e) => (this.wide = e.matches));
      this.refreshRail();
      this.refreshAgentStatus();
      this.refreshNeeds();
      this.connectBus();
      this.applyUrl();
      this.initPush();
      // The first tap anywhere unlocks audio playback on phones (see unlockAudio).
      const unlock = () => {
        this.unlockAudio();
        if (this.audioUnlocked) ["click", "touchend"].forEach((t) => document.removeEventListener(t, unlock, true));
      };
      ["click", "touchend"].forEach((t) => document.addEventListener(t, unlock, true));
      // Old hash links (#chat/<id>, #group/<id>, #alice) still open their drawer.
      const m = location.hash.match(/^#chat\/([a-z][a-z0-9_-]*)$/);
      if (m) this.openChat(m[1]);
      else if (location.hash === "#alice") this.openChat("alice");
      const g = location.hash.match(/^#group\/([a-z][a-z0-9-]*)$/);
      if (g) this.refreshRail().then(() => this.openGroup(g[1]));
      this.$watch("chatOpen", () => this.syncUrl());
      this.$watch("chatId", () => this.syncUrl());
      this.$watch("chatGroup", () => this.syncUrl());
      // Charts drawn while hidden have no size: draw or resize them when their tab or leaf shows.
      this.$watch("healthTab", () => this.$nextTick(() => this.renderCharts()));
      this.$watch("leaf", () => this.$nextTick(() => this.renderCharts()));
      let resizeTimer = 0;
      window.addEventListener("resize", () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => this.renderCharts(), 150);
      });
      window.addEventListener("popstate", () => this.applyUrl());
      // htmx 4 names it htmx:after:settle. Alpine binds swapped-in content itself (its mutation
      // observer), so this only restores deck state: open folds and new log rows.
      document.body.addEventListener("htmx:after:settle", (ev) => {
        const elt = ev.detail?.elt || ev.target;
        if (elt && elt.querySelector && elt.querySelector(".echart[data-option]")) this.renderCharts(elt);
        const view = document.getElementById("harbor-view");
        if (view && this.harborOpenFolds && this.harborOpenFolds.length && (elt === view || view.contains(elt))) {
          for (const sum of view.querySelectorAll("details > summary")) if (this.harborOpenFolds.includes(this.harborFoldKey(sum))) sum.parentElement.open = true;
        }
        // Ship's log rows that arrived since the last look get a short highlight.
        if (view && (elt === view || view.contains(elt))) {
          const key = this.shipSel || "";
          const ids = [...view.querySelectorAll(".log-row[data-id]")].map((r) => r.dataset.id);
          const seen = (this.logSeen ||= {})[key];
          if (seen) for (const r of view.querySelectorAll(".log-row[data-id]")) if (!seen.has(r.dataset.id)) {
            r.classList.add("is-new");
            setTimeout(() => r.classList.remove("is-new"), 4000);
          }
          this.logSeen[key] = new Set(ids);
        }
      });
      window.addEventListener("keydown", (ev) => this.onKeydown(ev));
    },

    onKeydown(ev) {
      const mod = ev.metaKey || ev.ctrlKey;
      if (mod && ev.key.toLowerCase() === "k") {
        ev.preventDefault();
        this.openPalette();
        return;
      }
      if (ev.altKey && ev.code === "KeyV" && this.chatOpen && !this.chatGroup) {
        ev.preventDefault();
        this.toggleListening();
        return;
      }
      if (!this.paletteOpen) {
        if (ev.key === "Escape" && this.voiceSpeaking) {
          ev.preventDefault();
          this.stopSpeaking();
          return;
        }
        if (ev.key === "Escape" && this.chatOpen) {
          ev.preventDefault();
          this.closeChat();
        }
        return;
      }
      const items = this.paletteItems();
      if (ev.key === "Escape") {
        ev.preventDefault();
        this.closePalette();
        return;
      }
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        this.paletteIndex = (this.paletteIndex + 1) % items.length;
        return;
      }
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        this.paletteIndex = (this.paletteIndex - 1 + items.length) % items.length;
        return;
      }
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.runPaletteItem(this.paletteIndex);
      }
    },

    openPalette() {
      this.paletteOpen = true;
      this.paletteIndex = 0;
      this.$nextTick(() => {
        const field = this.$refs.paletteField;
        if (field) field.focus();
      });
    },

    closePalette() {
      this.paletteOpen = false;
    },

    runPaletteItem(index) {
      const items = this.paletteItems();
      const item = items[index];
      if (item) item.run();
      this.closePalette();
    },

    /** /health, /agents pick the section; ?chat=<id> or ?group=<id> opens the drawer. */
    applyUrl() {
      let leaf = location.pathname.replace(/^\/+|\/+$/g, "");
      const sub = leaf.match(/^health\/([a-z]+)$/);
      if (sub && HEALTH_TABS.some((t) => t.id === sub[1])) {
        this.healthTab = sub[1];
        leaf = "health";
      }
      const ship = leaf.match(/^ships\/([a-z][a-z0-9_-]{0,63})$/);
      this.shipSel = ship ? ship[1] : "";
      // /fleet was folded into Health (Firstmate status and the project registry).
      this.leaf = ship ? "harbor" : leaf === "fleet" ? "health" : LEAVES.includes(leaf) ? leaf : "harbor";
      if (leaf === "fleet") history.replaceState(history.state, "", "/health" + location.search);
      if (this.leaf === "harbor") this.loadHarbor();
      const q = new URLSearchParams(location.search);
      const chat = q.get("chat");
      const group = q.get("group");
      if (chat && /^[a-z][a-z0-9_-]{0,63}$/.test(chat)) this.openChat(chat);
      else if (group && /^[a-z][a-z0-9-]{0,63}$/.test(group)) this.refreshRail().then(() => this.openGroup(group));
      else this.chatOpen = false;
    },

    leafUrl() {
      const q = !this.chatOpen ? "" : this.chatGroup ? `?group=${encodeURIComponent(this.chatGroup.id)}` : this.chatId ? `?chat=${encodeURIComponent(this.chatId)}` : "";
      const base =
        this.leaf === "harbor" && this.shipSel
          ? `/ships/${encodeURIComponent(this.shipSel)}`
          : this.leaf === "health" && this.healthTab !== "status"
            ? `/health/${this.healthTab}`
            : `/${this.leaf}`;
      return `${base}${q}`;
    },

    /**
     * ECharts (public/vendor, loaded on first use): every `.echart` element carries
     * its option as JSON in data-option (lib/metrics-view.ts). Hidden ones wait
     * until shown; a swap that replaced the element's canvas gets a fresh chart.
     */
    async renderCharts(root = document) {
      // Only charts on screen: a hidden tab's charts wait (and ECharts is not even loaded for them).
      const els = [...root.querySelectorAll(".echart[data-option]")].filter((el) => el.offsetWidth > 0);
      if (!els.length) return;
      if (!window.echarts) {
        this.echartsLoading ||= new Promise((resolve, reject) => {
          const tag = document.createElement("script");
          tag.src = "/vendor/echarts-6.1.0.min.js";
          tag.onload = resolve;
          tag.onerror = reject;
          document.head.appendChild(tag);
        });
        try {
          await this.echartsLoading;
        } catch {
          this.echartsLoading = null;
          return;
        }
      }
      for (const el of els) {
        let chart = window.echarts.getInstanceByDom(el);
        if (chart && !el.querySelector("canvas")) {
          chart.dispose();
          chart = null;
        }
        if (!chart) {
          chart = window.echarts.init(el, null, { renderer: "canvas" });
          el.dataset.drawn = "";
        }
        if (el.dataset.drawn !== el.dataset.option) {
          try {
            chart.setOption(JSON.parse(el.dataset.option), true);
            el.dataset.drawn = el.dataset.option;
          } catch {
            /* a bad option: leave the box empty */
          }
        }
        chart.resize();
      }
    },

    healthTabs: HEALTH_TABS,
    healthTab: "status",

    /** Switch Health's sub-tab; the URL follows (/health/metrics), so it can be bookmarked. */
    setHealthTab(id) {
      if (!HEALTH_TABS.some((t) => t.id === id)) return;
      this.healthTab = id;
      this.syncUrl(true);
    },

    /** Opening or switching a chat replaces the URL; changing section pushes a history entry. */
    syncUrl(push = false) {
      const url = this.leafUrl();
      if (url === location.pathname + location.search) return;
      try {
        if (push) history.pushState(null, "", url);
        else history.replaceState(null, "", url);
      } catch {
        /* sandboxed preview */
      }
    },

    /** Harbor or one ship's deck into #harbor-view. */
    loadHarbor() {
      this.harborPending = false;
      // Folds the captain opened stay open across the refresh (matched by their summary, numbers ignored).
      const view = document.getElementById("harbor-view");
      const foldKey = (sum) => sum.textContent.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
      this.harborOpenFolds = view ? [...view.querySelectorAll("details[open] > summary")].map(foldKey) : [];
      this.harborFoldKey = foldKey;
      this.$nextTick(() => this.pull(this.shipSel ? `/partials/ship/${encodeURIComponent(this.shipSel)}` : "/partials/harbor", "#harbor-view"));
    },

    /**
     * Live updates must not wipe what the captain is typing: while a form on
     * the deck has unsent edits and they are in it (or typed in the last two
     * minutes), refreshes wait and run once they leave it.
     */
    harborBusy() {
      const view = document.getElementById("harbor-view");
      if (!view) return false;
      const dirty = view.querySelector("form[data-dirty]");
      if (!dirty) return false;
      return dirty.contains(document.activeElement) || Date.now() - (this.harborTypedAt || 0) < 120_000;
    },

    refreshHarborSoon() {
      if (this.harborBusy()) this.harborPending = true;
      else this.loadHarbor();
    },

    openShip(id) {
      this.closePalette();
      this.logFailedOnly = false;
      this.chatOpen = false;
      this.leaf = "harbor";
      this.shipSel = id;
      this.syncUrl(true);
      this.loadHarbor();
    },

    /** Links inside the harbor partials navigate in place instead of reloading. */
    harborClick(ev) {
      const a = ev.target.closest("a");
      if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
      if (a.dataset.ship) {
        ev.preventDefault();
        this.openShip(a.dataset.ship);
      } else if (a.dataset.harbor !== undefined) {
        ev.preventDefault();
        this.openLeaf("harbor");
      } else if (a.dataset.chat) {
        ev.preventDefault();
        this.openChat(a.dataset.chat);
      }
    },

    /** Shipyard forms (data-api) post their fields as JSON and refresh the deck. */
    async harborSubmit(ev) {
      const form = ev.target.closest("form[data-api]");
      if (!form) return;
      ev.preventDefault();
      if (form.dataset.confirm && !confirm(form.dataset.confirm)) return;
      const body = {};
      for (const [k, v] of new FormData(form, ev.submitter)) body[k] = v;
      const note = form.querySelector("[data-note]");
      const buttons = form.querySelectorAll("button");
      buttons.forEach((b) => (b.disabled = true));
      if (note) note.textContent = "…";
      let j = { ok: false, message: "Could not reach the dashboard." };
      try {
        // A button can send the form elsewhere (data-api on the button), e.g. Check vs Submit.
        const api = (ev.submitter && ev.submitter.dataset.api) || form.dataset.api;
        const r = await fetch(api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        j = await r.json();
      } catch {
        /* keep the fallback */
      }
      buttons.forEach((b) => (b.disabled = false));
      if (!j.ok) {
        if (note) note.textContent = j.message || "Failed.";
        else alert(j.message || "Failed.");
        return;
      }
      // "note": show the answer in place and keep the form (a check, not a change).
      if ((ev.submitter && ev.submitter.dataset.then) === "note") {
        if (note) note.textContent = j.message || "OK.";
        return;
      }
      if (form.dataset.then === "ship" && body.id) return this.openShip(String(body.id));
      this.refreshRail();
      this.loadHarbor();
    },

    openLeaf(id) {
      this.chatOpen = false;
      if (id === "harbor") {
        this.shipSel = "";
        this.loadHarbor();
      }
      this.closePalette();
      this.leaf = id;
      this.syncUrl(true);
      this.hinge = id;
      window.setTimeout(() => {
        if (this.hinge === id) this.hinge = "";
      }, 100);
    },

    connectBus() {
      const es = new EventSource("/events");
      this.bus = es;
      es.addEventListener("usage", () => {
        this.pull("/partials/usage", "#usage");
        this.pull("/partials/metrics", "#metrics");
      });
      es.addEventListener("agents", () => {
        this.pull("/partials/fleet", "#fleet");
        this.pull("/partials/agents", "#agents");
        this.pull("/partials/groups", "#groups");
        this.refreshAgentStatus();
        this.refreshRail();
      });
      es.addEventListener("rail", () => {
        this.refreshRail();
        this.refreshNeeds();
      });
      es.addEventListener("needs", () => this.refreshNeeds());
      es.addEventListener("agents", () => this.refreshNeeds());
      // After a dashboard restart the stream reconnects; catch up on what changed meanwhile.
      es.addEventListener("open", () => this.refreshNeeds());
      // The ship's log moved, or crew came and went: refresh what the harbor shows.
      const harborRefresh = (ship) => {
        if (this.leaf !== "harbor" || document.hidden) return;
        if (!this.shipSel || !ship || ship === this.shipSel) this.refreshHarborSoon();
      };
      const view = document.getElementById("harbor-view");
      if (view) {
        view.addEventListener("input", (ev) => {
          const form = ev.target.closest && ev.target.closest("form");
          if (form) form.dataset.dirty = "1";
          this.harborTypedAt = Date.now();
        });
        view.addEventListener("focusout", () =>
          setTimeout(() => {
            if (this.harborPending && !this.harborBusy()) this.loadHarbor();
          }, 300),
        );
      }
      es.addEventListener("ship", (ev) => harborRefresh(ev.data));
      es.addEventListener("agents", () => harborRefresh(""));
      es.addEventListener("canvas", (ev) => {
        if (this.chatOpen && !this.chatGroup && ev.data === this.chatId) this.loadCanvas(true);
      });
      // Agent html canvases may post a message back: {type: "fleet-canvas", text}.
      window.addEventListener("message", (ev) => {
        // x-ref inside an x-if template is not reliably registered; query the live frame.
        const frame = document.querySelector("#chat-drawer .canvas-frame");
        if (!frame || ev.source !== frame.contentWindow) return;
        const d = ev.data;
        if (!d || d.type !== "fleet-canvas" || typeof d.text !== "string" || !d.text.trim()) return;
        const item = this.canvasItem();
        const text = d.text.trim().slice(0, 2000);
        // A page that posts on load would resend on every reload; accept each message once per item version.
        const key = `fleet-canvas-posted:${this.chatId}:${item ? item.id + ":" + item.updated : "page"}:${text}`;
        try {
          if (localStorage.getItem(key)) return;
          localStorage.setItem(key, "1");
        } catch { /* private mode: no dedupe */ }
        this.sendText(this.chatId, `From the canvas "${item ? item.title : "page"}": ${text}`);
      });
    },

    pull(url, target) {
      if (window.htmx) {
        htmx.ajax("GET", url, { target, swap: "innerMorph" });
      }
    },

    async refreshAgentStatus() {
      try {
        const r = await fetch("/api/agents");
        const j = await r.json();
        const waiting = (j.agents || []).find((a) => a.waitingOnYou);
        this.waiting = Boolean(waiting);
        this.waitSummary = waiting
          ? `Waiting on you: ${waiting.firstmateWaitSummary || waiting.id}`
          : "";
      } catch {
        /* keep last */
      }
    },

    async refreshRail() {
      try {
        const [r, rg] = await Promise.all([fetch("/api/chat-targets"), fetch("/api/groups")]);
        const j = await r.json();
        this.rail = { agents: j.agents || [], workers: j.workers || [] };
        this.refreshFaces();
        this.groups = (await rg.json()).groups || [];
        if (this.chatGroup) this.chatGroup = this.groups.find((g) => g.id === this.chatGroup.id) || null;
        const cur = this.findTarget(this.chatId);
        if (cur && cur.kind !== "firstmate" && cur.kind !== "task") this.chatThinking = Boolean(cur.thinking);
      } catch {
        /* keep last */
      }
    },

    railTip: { text: "", x: 0, y: 0 },

    /** Show a rail face's name beside it (hover or keyboard focus). */
    showTip(ev) {
      const el = ev.currentTarget;
      const name = el && el.dataset.name;
      if (!name || window.matchMedia("(hover: none)").matches) return;
      const r = el.getBoundingClientRect();
      this.railTip = { text: name, x: r.left, y: r.top + r.height / 2 };
    },

    hideTip() {
      this.railTip = { text: "", x: 0, y: 0 };
    },

    /** Rail entries with anyone waiting on the captain first (order otherwise kept). */
    railList(kind) {
      const list = this.rail[kind] || [];
      return list.filter((t) => t.waiting).concat(list.filter((t) => !t.waiting));
    },

    /** Someone needs the captain: a Firstmate wait/hold or an agent blocked on a question. */
    anyWaiting() {
      return this.waiting || this.rail.agents.some((t) => t.waiting) || this.rail.workers.some((t) => t.waiting);
    },

    /** Ship deck: show only failed turns in the log (kept across deck refreshes). */
    logFailedOnly: false,

    showFailedLog() {
      this.logFailedOnly = true;
      this.$nextTick(() => document.getElementById("ship-log")?.scrollIntoView({ block: "start" }));
    },

    needsBusy: false,
    needsAgain: false,

    async refreshNeeds() {
      // One fetch at a time; a change during it triggers one more.
      if (this.needsBusy) {
        this.needsAgain = true;
        return;
      }
      this.needsBusy = true;
      try {
        const [r, q] = await Promise.all([fetch("/api/needs-you"), fetch("/api/quiet")]);
        const prevNotices = new Set(this.needs.filter((i) => i.kind === "notice").map((i) => i.id));
        this.needs = (await r.json()).items || [];
        this.quiet = await q.json().catch(() => this.quiet);
        this.renderNeeds();
        // New interrupting notices are spoken when voice is on (once the first load has set the baseline).
        if (this.needsLoaded && this.voiceReplies && !this.quiet.snoozed) {
          for (const n of this.needs) if (n.kind === "notice" && !prevNotices.has(n.id)) this.queueSpeech(n.from === "fleet" ? "alice" : n.from, n.noticeKind === "digest" ? `${n.summary}. It is on Needs you.` : n.summary);
        }
        this.needsLoaded = true;
        document.title = this.needs.length ? `(${this.needs.length}) Fleet` : "Fleet";
      } catch {
        /* keep last */
      } finally {
        this.needsBusy = false;
        if (this.needsAgain) {
          this.needsAgain = false;
          this.refreshNeeds();
        }
      }
    },

    /** Keyed render: cards that stay keep their DOM, so a half-typed answer survives a refresh. */
    renderNeeds() {
      const list = document.getElementById("needs-list");
      if (!list) return;
      const keep = new Map([...list.children].map((el) => [el.dataset.id, el]));
      const ids = new Set(this.needs.map((i) => i.id));
      for (const [id, el] of keep) if (!ids.has(id)) el.remove();
      for (const item of this.needs) {
        const el = keep.get(item.id) || this.needCard(item);
        list.appendChild(el);
      }
    },

    needCard(item) {
      const card = document.createElement("article");
      card.className = `d-card d-card-border bg-base-100 need is-${item.kind}`;
      card.dataset.id = item.id;
      const helmsman = item.kind === "helm" ? `${item.ship}-helmsman` : "";
      const t = item.agentId
        ? this.findTarget(item.agentId) || { id: item.agentId, label: item.label, art: item.art, ship: item.ship }
        : helmsman
          ? this.findTarget(helmsman) || { id: helmsman, label: "Helmsman", art: null, ship: item.ship }
          : { id: "firstmate", label: "Firstmate", art: (this.findTarget("firstmate") || {}).art };
      const face = this.faceHtml(t);
      const when = item.ts ? `<time class="muted need-when" datetime="${escapeHtml(item.ts)}">${escapeHtml(agoText(item.ts))}</time>` : "";
      const openChat = item.agentId ? `<button type="button" class="d-btn d-btn-sm" data-open>Open chat</button>` : "";
      if (item.kind === "question") {
        card.innerHTML = `${face}<div class="need-body question-block">
          <div class="need-head"><h3>${escapeHtml(item.label)} asks${item.live ? "" : " (its turn has ended; your answer goes as a message)"}</h3>${when}</div>
          ${this.questionsHtml(item)}
          <div class="row question-actions"><button type="button" class="d-btn d-btn-neutral d-btn-sm" data-send>Send answer</button>${item.live ? '<button type="button" class="d-btn d-btn-sm" data-skip>Skip</button>' : '<button type="button" class="d-btn d-btn-sm" data-dismiss>Dismiss</button>'}${openChat}<span class="muted" data-note></span></div>
        </div>`;
        this.wireQuestion(card, item.agentId, item.live ? item.dialog : null, (text) => this.postCaptain(item.agentId, text, card));
      } else if (item.kind === "notice") {
        const who = this.findTarget(item.from) || { id: item.from, label: item.from === "fleet" ? "Fleet" : item.from, art: null };
        const title = item.noticeKind === "digest" ? item.summary : `${who.label}: ${{ done: "done", blocked: "blocked", decision: "needs a decision", milestone: "milestone" }[item.noticeKind] || item.noticeKind}`;
        card.classList.add(item.noticeKind === "blocked" || item.noticeKind === "decision" ? "is-question" : "is-notice");
        card.innerHTML = `${this.faceHtml(who)}<div class="need-body">
          <div class="need-head"><h3>${escapeHtml(title)}</h3>${when}</div>
          ${item.noticeKind === "digest" ? "" : `<p class="need-reason">${escapeHtml(item.summary)}</p>`}
          ${item.detail ? `<details class="d-collapse d-collapse-arrow d-collapse-border bg-base-100" ${item.noticeKind === "digest" ? "open" : ""}><summary class="d-collapse-title">${item.noticeKind === "digest" ? "The digest" : "More"}</summary><div class="d-collapse-content"><div class="md">${renderMarkdown(item.detail)}</div></div></details>` : ""}
          ${item.ref ? `<p class="muted">${escapeHtml(item.ref)}</p>` : ""}
          <div class="row question-actions"><button type="button" class="d-btn d-btn-neutral d-btn-sm" data-ack>Got it</button>${item.from !== "fleet" ? '<button type="button" class="d-btn d-btn-sm" data-open-notice>Open chat</button>' : ""}<span class="muted" data-note></span></div>
        </div>`;
        card.querySelector("[data-ack]").addEventListener("click", async () => {
          card.querySelectorAll("button").forEach((b) => (b.disabled = true));
          await fetch(`/api/notices/${item.noticeId}/ack`, { method: "POST" }).catch(() => {});
          card.classList.add("is-done");
          this.refreshNeeds();
        });
        const on = card.querySelector("[data-open-notice]");
        if (on) on.addEventListener("click", () => this.openChat(item.from));
      } else if (item.kind === "go") {
        card.classList.add("is-question");
        card.innerHTML = `${face}<div class="need-body">
          <div class="need-head"><h3>${escapeHtml(item.label)} wants to act on the fleet</h3>${when}</div>
          <p class="need-reason">${escapeHtml(item.summary)}</p>
          <div class="row question-actions"><button type="button" class="d-btn d-btn-neutral d-btn-sm" data-go="go">Go</button><button type="button" class="d-btn d-btn-sm" data-go="no">No</button>${openChat}<span class="muted" data-note></span></div>
        </div>`;
        card.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => this.answerGo(item.goId, b.dataset.go, card)));
      } else if (item.kind === "helm") {
        card.classList.add("is-question");
        const api = `/api/ships/${encodeURIComponent(item.ship)}/helm/${encodeURIComponent(item.proposalId)}`;
        card.innerHTML = `${face}<div class="need-body">
          <div class="need-head"><h3>${escapeHtml(item.ship)}'s helmsman proposes a change</h3>${when}</div>
          <p class="need-reason"><code>${escapeHtml(item.what)}</code></p>
          <p class="muted">${escapeHtml(item.why)}</p>
          <div class="row question-actions">${item.note ? "" : `<button type="button" class="d-btn d-btn-neutral d-btn-sm" data-helm="apply">Apply</button>`}<button type="button" class="d-btn d-btn-sm" data-helm="dismiss">${item.note ? "Read" : "Dismiss"}</button><a class="d-btn d-btn-sm" href="/ships/${encodeURIComponent(item.ship)}">Open the deck</a><span class="muted" data-note></span></div>
        </div>`;
        card.querySelectorAll("[data-helm]").forEach((b) =>
          b.addEventListener("click", async () => {
            const note = card.querySelector("[data-note]");
            card.querySelectorAll("[data-helm]").forEach((x) => (x.disabled = true));
            try {
              const r = await fetch(`${api}/${b.dataset.helm}`, { method: "POST" });
              const j = await r.json();
              if (note) note.textContent = j.message || "";
              if (r.ok) card.classList.add("is-done");
              else card.querySelectorAll("[data-helm]").forEach((x) => (x.disabled = false));
            } catch {
              if (note) note.textContent = "The dashboard did not answer.";
              card.querySelectorAll("[data-helm]").forEach((x) => (x.disabled = false));
            }
            this.refreshNeeds();
          }),
        );
      } else if (item.kind === "gate") {
        card.classList.add("is-question");
        card.innerHTML = `${face}<div class="need-body">
          <div class="need-head"><h3>${escapeHtml(item.label)}: a tool call held for review</h3>${when}</div>
          <p class="need-reason"><code>${escapeHtml(item.summary)}</code></p>
          <p class="muted">${escapeHtml(item.why)} · ${escapeHtml(item.jev)}</p>
          <div class="row question-actions"><button type="button" class="d-btn d-btn-neutral d-btn-sm" data-gate="allow">Allow once</button><button type="button" class="d-btn d-btn-sm" data-gate="deny">Deny</button>${openChat}<span class="muted" data-note></span></div>
        </div>`;
        card.querySelectorAll("[data-gate]").forEach((b) =>
          b.addEventListener("click", async () => {
            const note = card.querySelector("[data-note]");
            card.querySelectorAll("[data-gate]").forEach((x) => (x.disabled = true));
            try {
              const r = await fetch(`/api/gate/${encodeURIComponent(item.gateId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: b.dataset.gate }) });
              const j = await r.json();
              if (note) note.textContent = j.message || "";
              if (r.ok) card.classList.add("is-done");
              else card.querySelectorAll("[data-gate]").forEach((x) => (x.disabled = false));
            } catch {
              if (note) note.textContent = "The dashboard did not answer.";
              card.querySelectorAll("[data-gate]").forEach((x) => (x.disabled = false));
            }
            this.refreshNeeds();
          }),
        );
      } else if (item.kind === "order") {
        const alice = this.findTarget("alice") || { id: "alice", label: "Alice", art: null };
        const oface = alice.art ? `<img class="avatar" src="${alice.art}" alt="" width="48" height="48" />` : face;
        const paused = item.status === "needs-captain";
        card.innerHTML = `${oface}<div class="need-body">
          <div class="need-head"><h3>${paused ? "Order paused" : "Order waiting for your Go"}: “${escapeHtml(item.title)}”</h3><span class="muted need-when">by ${escapeHtml(item.by)}</span></div>
          ${paused && item.reason ? `<p class="need-reason warn">${escapeHtml(item.reason)}</p>` : ""}
          <ol class="order-steps">${item.steps.map((s, i) => `<li${paused && item.resume && i + 1 < item.resume ? ' class="is-done"' : ""}>${escapeHtml(s)}</li>`).join("")}</ol>
          <div class="row question-actions"><button type="button" class="d-btn d-btn-neutral d-btn-sm" data-order="${paused ? "retry" : "go"}">${paused ? `Retry from step ${item.resume || 1}` : "Go"}</button><button type="button" class="d-btn d-btn-sm" data-order="cancel">Cancel</button><span class="muted" data-note></span></div>
        </div>`;
        card.querySelectorAll("[data-order]").forEach((b) => b.addEventListener("click", () => this.orderAction(item.slug, b.dataset.order, card)));
      } else if (item.kind === "hold") {
        card.innerHTML = `${face}<div class="need-body">
          <div class="need-head"><h3>Firstmate holds “${escapeHtml(item.title)}”</h3><span class="d-badge d-badge-sm d-badge-error">before it ships</span></div>
          ${item.reason ? `<p class="need-reason">${escapeHtml(item.reason)}</p>` : ""}
          <textarea class="d-textarea" maxlength="8000" aria-label="Your decision on ${escapeHtml(item.title)}" placeholder="Your decision"></textarea>
          <div class="row question-actions"><button type="button" class="d-btn d-btn-neutral d-btn-sm" data-hold>Record answer</button><span class="muted" data-note></span></div>
        </div>`;
        card.querySelector("[data-hold]").addEventListener("click", () => this.answerHold(item.taskId, card));
      } else {
        card.innerHTML = `${face}<div class="need-body">
          <div class="need-head"><h3>Your message to ${escapeHtml(item.label)} did not go through</h3>${when}</div>
          <blockquote class="need-sent">${escapeHtml(item.sentText)}</blockquote>
          <div class="need-error">${errorHtml(item.error)}</div>
          <div class="row question-actions"><button type="button" class="d-btn d-btn-neutral d-btn-sm" data-resend>Send again</button>${openChat}<button type="button" class="d-btn d-btn-sm" data-dismiss>Dismiss</button><span class="muted" data-note></span></div>
        </div>`;
        card.querySelector("[data-resend]").addEventListener("click", () => this.postCaptain(item.agentId, item.sentText, card));
      }
      const open = card.querySelector("[data-open]");
      if (open) open.addEventListener("click", () => this.openChat(item.agentId));
      const dismiss = card.querySelector("[data-dismiss]");
      if (dismiss) dismiss.addEventListener("click", () => this.dismissNeed(item.id, card));
      return card;
    },

    /** A captain message from a Needs-you card: POSTed (no drawer involved), retried with one id. */
    async postCaptain(to, text, card) {
      const note = card.querySelector("[data-note]");
      const requestId = crypto.randomUUID();
      card.querySelectorAll("button, input, textarea").forEach((el) => (el.disabled = true));
      if (note) note.textContent = "Sending…";
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const r = await fetch("/chat/" + encodeURIComponent(to), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, requestId }),
          });
          const j = await r.json();
          if (j.ok) {
            card.classList.add("is-done");
            if (note) note.textContent = "Sent";
            return;
          }
          break;
        } catch {
          await new Promise((res) => setTimeout(res, 800 * 2 ** attempt));
        }
      }
      card.querySelectorAll("button, input, textarea").forEach((el) => (el.disabled = false));
      if (note) note.textContent = "Not sent; try again.";
    },

    async answerHold(taskId, card) {
      const field = card.querySelector("textarea");
      const note = card.querySelector("[data-note]");
      const text = field.value.trim();
      if (!text) {
        note.textContent = "Write your decision first.";
        return;
      }
      note.textContent = "Recording…";
      try {
        const r = await fetch(`/api/holds/${encodeURIComponent(taskId)}/answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        const reply = new DOMParser().parseFromString(await r.text(), "text/html").body.textContent.trim();
        note.textContent = reply || (r.ok ? "Recorded." : "Not recorded.");
        if (r.ok) {
          card.classList.add("is-done");
          card.querySelectorAll("button, textarea").forEach((el) => (el.disabled = true));
        }
      } catch {
        note.textContent = "Not recorded; try again.";
      }
    },

    /** The captain's Go or No on a held fleet action; the node runs it and tells the agent. */
    async answerGo(id, decision, el) {
      const note = el.querySelector("[data-note]");
      el.querySelectorAll("[data-go]").forEach((b) => (b.disabled = true));
      if (note) note.textContent = decision === "go" ? "Running…" : "…";
      try {
        const r = await fetch(`/api/go/${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) });
        const j = await r.json();
        if (note) note.textContent = decision === "go" ? (j.ok ? "Done: " : "Failed: ") + (j.message || "") : j.message || "Declined.";
        if (r.status === 409 || j.ok) el.classList.add("is-done", "is-answered");
        else el.querySelectorAll("[data-go]").forEach((b) => (b.disabled = false));
      } catch {
        if (note) note.textContent = "Not sent; try again.";
        el.querySelectorAll("[data-go]").forEach((b) => (b.disabled = false));
      }
    },

    async toggleQuiet() {
      try {
        const r = await fetch("/api/quiet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ snooze: !this.quiet.snoozed }) });
        const j = await r.json();
        this.quiet = { ...this.quiet, snoozed: !!j.snoozed, held: j.snoozed ? this.quiet.held : 0 };
        this.refreshNeeds();
      } catch {
        /* stays as it was */
      }
    },

    async orderAction(slug, action, card) {
      const note = card.querySelector("[data-note]");
      card.querySelectorAll("button").forEach((b) => (b.disabled = true));
      note.textContent = "…";
      try {
        const r = await fetch(`/api/orders/${encodeURIComponent(slug)}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        const j = await r.json();
        note.textContent = j.message || (j.ok ? "Done." : "Failed.");
        if (j.ok) card.classList.add("is-done");
        else card.querySelectorAll("button").forEach((b) => (b.disabled = false));
      } catch {
        note.textContent = "Not sent; try again.";
        card.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    },

    async dismissNeed(id, card) {
      try {
        const r = await fetch("/api/needs-you/dismiss", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
        if ((await r.json()).ok) card.remove();
      } catch {
        /* stays */
      }
      this.refreshNeeds();
    },

    findTarget(id) {
      return this.rail.agents.find((t) => t.id === id) || this.rail.workers.find((t) => t.id === id);
    },

    current() {
      const id = this.chatGroup ? this.groupTo : this.chatId;
      return this.findTarget(id) || { id, label: id, art: null };
    },

    title() {
      return this.chatGroup ? this.chatGroup.name : this.current().label || this.chatId;
    },

    groupFaces(g) {
      return [g.lead].concat(g.members.filter((m) => m !== g.lead)).slice(0, 3).map((id) => this.findTarget(id)).filter(Boolean);
    },

    /**
     * A chat bubble's face: the portrait when the rail knows it; a symbol for the fleet's own
     * senders (helm, sssf, gate); otherwise initials marked with data-face, so refreshFaces can
     * swap in the portrait when the rail loads after the history replayed.
     */
    bubbleFace(t) {
      const id = (t && t.id) || "";
      const known = this.findTarget(id);
      const art = (known && known.art) || (t && t.art);
      if (art) return `<img class="avatar" src="${art}" alt="" width="48" height="48" />`;
      const glyph = { helm: "⚓", sssf: "⚙️", gate: "🛡️", go: "✅", vault: "📚", "vault-doctor": "📚" }[id];
      if (glyph) return `<span class="avatar portrait-initials is-system" title="${escapeHtml(id)}">${glyph}</span>`;
      return `<span class="avatar portrait-initials" data-face="${escapeHtml(id)}">${escapeHtml(this.initials(known || t))}</span>`;
    },

    /** Swap initials in chat bubbles for portraits the rail has now (history can replay before the rail loads). */
    refreshFaces() {
      document.querySelectorAll(".bubble-row .portrait-initials[data-face]").forEach((el) => {
        const t = this.findTarget(el.dataset.face);
        if (!t || !t.art) return;
        const img = document.createElement("img");
        img.className = "avatar";
        img.src = t.art;
        img.alt = "";
        img.width = 48;
        img.height = 48;
        el.replaceWith(img);
      });
    },

    initials(t) {
      const words = String((t && (t.label || t.id)) || "?").replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/);
      return ((words[0] || "?")[0] + (words[1] ? words[1][0] : (words[0] || "")[1] || "")).toUpperCase();
    },

    chatMeta() {
      if (this.chatGroup) {
        const g = this.chatGroup;
        return `lead ${g.lead} · ${g.members.length} member${g.members.length === 1 ? "" : "s"}${g.adw ? ` · ${g.adw.ship} ${g.adw.chain}` : ""}`;
      }
      const t = this.current();
      if (t.kind === "task") return [t.state, t.project].filter(Boolean).join(" · ");
      if (t.kind === "firstmate") return "replies in its TUI";
      const lt = t.lastTurn;
      const turn = lt ? ` · ${lt.status === "ok" ? "last reply took" : `last turn ${lt.status} after`} ${formatDuration(lt.ms)}` : "";
      const model = t.backupModel ? `on backup ${t.backupModel.replace(/^[a-z]+\//, "")}` : (t.model || "").replace(/^[a-z]+\//, "");
      return model + turn;
    },

    toggleChat() {
      if (this.chatOpen) this.closeChat();
      else if (this.chatGroup) this.chatOpen = true;
      else this.openChat(this.chatId);
    },

    openChat(id) {
      this.closePalette();
      const switching = id !== this.chatId || this.chatGroup || !this.chatWs;
      this.chatGroup = null;
      this.chatId = id;
      saveChatId(id);
      this.chatOpen = true;
      if (this.voiceReplies) this.preloadAcks(id);
      if (switching) {
        this.connectThreads([id]);
        this.canvasItems = [];
        this.canvasOpen = false;
        this.canvasFresh = false;
        this.loadCanvas(false);
      }
      this.focusComposer();
    },

    canvasSeenKey(id) {
      return "fleet-canvas-seen:" + id;
    },

    /** Fetch the current agent's canvas; focus = open on anything newer than last seen. */
    async loadCanvas(focus) {
      const id = this.chatId;
      try {
        const r = await fetch("/api/canvas/" + encodeURIComponent(id));
        const items = (await r.json()).items || [];
        if (id !== this.chatId || this.chatGroup) return;
        this.canvasItems = items;
        if (!items.find((i) => i.id === this.canvasSel)) this.canvasSel = items[0] ? items[0].id : "";
        let seen = "";
        try { seen = localStorage.getItem(this.canvasSeenKey(id)) || ""; } catch { /* private mode */ }
        const newest = items[0];
        if (focus && newest && newest.updated > seen) {
          this.canvasSel = newest.id;
          // Wide screens show the canvas beside the chat; narrower ones would hide the thread, so flag the button instead.
          if (this.wide) this.canvasOpen = true;
          else this.canvasFresh = true;
        }
        if (!items.length) this.canvasOpen = false;
        if (this.canvasOpen && newest) this.markCanvasSeen();
      } catch {
        /* keep last */
      }
    },

    markCanvasSeen() {
      const newest = this.canvasItems[0];
      if (!newest) return;
      try { localStorage.setItem(this.canvasSeenKey(this.chatId), newest.updated); } catch { /* private mode */ }
    },

    canvasShown() {
      return this.canvasOpen && !this.chatGroup && this.canvasItems.length > 0;
    },

    toggleCanvas() {
      this.canvasOpen = !this.canvasOpen;
      this.canvasFresh = false;
      if (this.canvasOpen) this.markCanvasSeen();
    },

    canvasItem() {
      return this.canvasItems.find((i) => i.id === this.canvasSel) || null;
    },

    canvasSrc(item, file) {
      return `/canvas/${encodeURIComponent(this.chatId)}/${encodeURIComponent(item.id)}/${file.split("/").map(encodeURIComponent).join("/")}?v=${encodeURIComponent(item.updated)}`;
    },

    canvasFrameSrc(item) {
      if (!item) return "about:blank";
      if (item.kind === "url") return item.url;
      if (item.kind === "html") return this.canvasSrc(item, item.entry || "index.html");
      return `/canvas/${encodeURIComponent(this.chatId)}/${encodeURIComponent(item.id)}/view?v=${encodeURIComponent(item.updated)}`;
    },

    canvasSandbox(item) {
      if (!item) return "";
      if (item.kind === "url") return "allow-scripts allow-forms allow-same-origin allow-popups";
      if (item.kind === "html") return "allow-scripts allow-forms allow-popups";
      return "";
    },

    pickCanvasImage(item, img) {
      this.sendText(this.chatId, `Picked "${img.label}" from "${item.title}" on the canvas.`);
    },

    /** A group stacks its members' threads; the composer defaults to the lead. */
    openGroup(id) {
      const g = this.groups.find((x) => x.id === id);
      if (!g) return;
      this.closePalette();
      this.chatGroup = g;
      this.groupTo = g.lead;
      this.chatOpen = true;
      this.connectThreads(g.members);
      this.focusComposer();
    },

    focusComposer() {
      this.$nextTick(() => {
        const field = this.$refs.chatField;
        if (field) field.focus();
      });
    },

    closeChat() {
      this.chatOpen = false;
    },

    connectThreads(ids) {
      const gen = ++this.chatGen;
      for (const ws of Object.values(this.chatSockets)) {
        ws.onclose = null;
        try { ws.close(); } catch { /* gone */ }
      }
      this.chatSockets = {};
      this.chatWs = null;
      const log = this.$refs.chatLog;
      if (log) log.querySelectorAll(".bubble-row:not([x-show])").forEach((n) => n.remove());
      this.chatEmpty = true;
      this.chatThinking = false;
      this.chatConn = "connecting";
      for (const id of ids) this.connectOne(id, gen);
    },

    connectOne(id, gen) {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/ws/chat/${encodeURIComponent(id)}`);
      this.chatSockets[id] = ws;
      if (!this.chatGroup) this.chatWs = ws;
      ws.onopen = () => {
        if (gen === this.chatGen) this.chatConn = "open";
      };
      ws.onclose = () => {
        if (gen !== this.chatGen) return;
        delete this.chatSockets[id];
        if (this.chatWs === ws) this.chatWs = null;
        const live = Boolean(this.findTarget(id));
        if (!this.chatGroup) this.chatConn = live ? "closed" : "not on the rail";
        if (live) setTimeout(() => { if (gen === this.chatGen) this.connectOne(id, gen); }, 4000);
      };
      ws.onmessage = (ev) => {
        if (gen !== this.chatGen) return;
        try {
          const m = JSON.parse(ev.data);
          if (m.error) return;
          if (m.event) return this.onAgentEvent(m.event, id);
          // Live (rpc) agents narrate mid-task; their running event decides "thinking".
          const t = this.findTarget(id);
          if (m.role !== "captain" && !(t && t.runtime === "rpc")) this.chatThinking = false;
          this.appendChatLine(m, id);
          this.maybeSpeak(m, id);
        } catch {
          /* ignore */
        }
      };
    },

    /**
     * Lines saved before steps were marked: an agent line followed by another
     * line from the same agent, with nothing from anyone else between, was
     * narration on the way to its answer.
     */
    markEarlierStep(row) {
      let prev = row.previousElementSibling;
      while (prev && (prev.classList.contains("is-system") || prev.classList.contains("is-streaming"))) prev = prev.previousElementSibling;
      if (!prev || prev.dataset.kind !== "chat" || prev.dataset.role !== row.dataset.role || prev.dataset.thread !== row.dataset.thread || prev.classList.contains("is-step")) return;
      prev.classList.add("is-step");
      const name = prev.querySelector(".bubble-name");
      if (name && !name.textContent.endsWith(" · thinking")) name.textContent += " · thinking";
    },

    toggleThinking() {
      this.showThinking = !this.showThinking;
      try {
        localStorage.setItem("fleet.showThinking", this.showThinking ? "1" : "0");
      } catch {
        /* private window */
      }
    },

    appendChatLine(m, threadId) {
      const log = this.$refs.chatLog;
      if (!log) return;
      this.chatEmpty = false;
      const tid = threadId || this.chatId;
      // Replays and live events repeat lines; ts + kind identifies one (an answer and
      // the follow-up dialog it opens can share a millisecond).
      const kind = m.kind || "chat";
      // The server's copy of a message shown as "sending…": settle it in place.
      let settled = false;
      if (m.requestId && m.role === "captain") {
        const pending = log.querySelector(`.bubble-row[data-request="${CSS.escape(m.requestId)}"]`);
        if (pending) {
          pending.remove();
          settled = true;
        }
      }
      if (m.ts && log.querySelector(`[data-at="${CSS.escape(m.ts)}"][data-kind="${CSS.escape(kind)}"][data-thread="${CSS.escape(tid)}"]`)) return;
      const t = this.findTarget(tid) || { id: tid, label: tid, art: null };
      const row = document.createElement("div");
      if (m.kind === "error") {
        row.className = "bubble-row is-system is-error";
        row.innerHTML = `<div class="bubble"><span class="bubble-name">Not sent</span>${errorHtml(m.text)}</div>`;
        const target = m.ref ? log.querySelector(`[data-ts="${CSS.escape(m.ref)}"][data-thread="${CSS.escape(tid)}"]`) : null;
        if (target) {
          target.classList.add("is-failed");
          target.after(row);
          return;
        }
      } else if (m.kind === "question" && m.go) {
        // A fleet action held by the server until the captain says Go (lib/go-gate.ts).
        row.className = "d-chat d-chat-start bubble-row is-agent is-question is-go";
        const face = this.bubbleFace(t);
        const summary = (m.questions && m.questions[0] && m.questions[0].question) || m.text;
        row.innerHTML = `${face}<div class="d-chat-bubble bubble question-block">
          <span class="bubble-name">${escapeHtml(t.label || m.role)} wants to act on the fleet</span>
          <p class="go-summary">${escapeHtml(summary)}</p>
          <div class="row question-actions"><button type="button" class="d-btn d-btn-neutral d-btn-sm" data-go="go">Go</button><button type="button" class="d-btn d-btn-sm" data-go="no">No</button><span class="muted" data-note></span></div>
        </div>`;
        row.dataset.go = m.go.id;
        row.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => this.answerGo(m.go.id, b.dataset.go, row)));
      } else if (m.kind === "question" && Array.isArray(m.questions) && m.questions.length) {
        row.className = "d-chat d-chat-start bubble-row is-agent is-question";
        const face = this.bubbleFace(t);
        row.innerHTML = `${face}<div class="d-chat-bubble bubble question-block">
          <span class="bubble-name">${escapeHtml(t.label || m.role)} asks</span>
          ${this.questionsHtml(m)}
          <div class="row question-actions"><button type="button" class="d-btn d-btn-neutral d-btn-sm" data-send>${m.dialog ? "Send answer" : "Send answers"}</button>${m.dialog ? '<button type="button" class="d-btn d-btn-sm" data-skip>Skip</button>' : ""}<span class="muted" data-note></span></div>
        </div>`;
        if (m.dialog) row.dataset.dialog = m.dialog.id;
        this.wireQuestion(row, tid, m.dialog);
      } else if (m.kind === "answer") {
        row.className = "d-chat d-chat-end bubble-row is-captain is-answer";
        row.innerHTML = `<div class="d-chat-bubble bubble"><span class="bubble-name">You answered</span><p>${escapeHtml(m.text)}</p></div>`;
        if (m.ref) this.markDialogAnswered(log, tid, m.ref, m.text);
      } else if (m.kind === "crew") {
        // A crewmate wrote to this agent (lead ↔ crew); show who, not the thread's agent.
        const from = this.findTarget(m.role) || { id: m.role, label: m.role, art: null };
        row.className = "d-chat d-chat-start bubble-row is-agent is-crew";
        const face = this.bubbleFace(from);
        row.innerHTML = `${face}<div class="d-chat-bubble bubble"><span class="bubble-name">${escapeHtml(from.label)} → ${escapeHtml(t.label || tid)}</span><div class="md">${renderMarkdown(m.text)}</div></div>`;
      } else if (m.role === "system" || m.role === "dashboard") {
        row.className = "bubble-row is-system";
        row.innerHTML = `<div class="bubble"><p>${escapeHtml(m.text)}</p></div>`;
      } else {
        const mine = m.role === "captain";
        row.className = `d-chat ${mine ? "d-chat-end" : "d-chat-start"} bubble-row is-${mine ? "captain" : "agent"}`;
        if (m.ts) row.dataset.ts = m.ts;
        row.dataset.thread = tid;
        const face = mine ? "/art/captain.png" : t.art;
        const to = this.chatGroup ? ` → ${t.label}` : "";
        const name = mine ? "You" + to : t.label || m.role;
        const avatar = mine ? `<img class="avatar" src="${face}" alt="" width="48" height="48" />` : this.bubbleFace(t);
        row.innerHTML = `${avatar}<div class="d-chat-bubble bubble"><span class="bubble-name">${escapeHtml(name)}${!mine && m.step ? " · thinking" : ""}</span><div class="md">${renderMarkdown(m.text)}</div></div>`;
        if (!mine) {
          row.dataset.role = m.role;
          if (m.step) row.classList.add("is-step");
        }
      }
      if (m.ts) row.dataset.at = m.ts;
      if (settled) row.classList.add("is-sent-settle");
      row.dataset.kind = kind;
      row.dataset.thread = tid;
      if (m.role === "captain" && m.ts) this.markAnswered(log, tid, m.ts);
      // Stacked group threads replay one member at a time; keep the drawer in time order.
      const later = m.ts ? [...log.querySelectorAll(".bubble-row[data-at]")].find((n) => n.dataset.at > m.ts) : null;
      if (later) log.insertBefore(row, later);
      else log.appendChild(row);
      if (kind === "chat" && row.dataset.role) this.markEarlierStep(row);
      while (log.childElementCount > LOG_MAX) log.removeChild(log.firstChild);
      if (!later) log.scrollTop = log.scrollHeight;
    },

    questionsHtml(m) {
      const intro = (m.text || "").split("\n")[0].replace(/^Question for you:\s*/, "");
      const qs = m.questions
        .map((q, qi) => {
          // ask_captain's "Other (type an answer)" opens a second dialog; the text box below already sends typed text.
          const opts = (q.options || [])
            .filter((o) => !/^Other \(type an answer\)$/.test(o))
            .map(
              (o) =>
                `<button type="button" class="chip" data-q="${qi}" data-opt="${escapeHtml(o)}" aria-pressed="false">${escapeHtml(o)}${o === q.recommended && !/recommended\)?$/i.test(o) ? ' <span class="d-badge d-badge-outline d-badge-sm">recommended</span>' : ""}</button>`,
            )
            .join("");
          return `<fieldset class="question" data-qi="${qi}">
            <legend>${escapeHtml(q.question)}</legend>
            <div class="row-wrap">${opts}</div>
            <input class="d-input d-input-sm" data-other="${qi}" placeholder="${opts ? "Or type another answer" : "Your answer"}" aria-label="${escapeHtml(q.question)}" />
          </fieldset>`;
        })
        .join("");
      return `${intro ? `<p>${escapeHtml(intro)}</p>` : ""}${qs}`;
    },

    wireQuestion(row, tid, dialog, send = (text) => this.sendText(tid, text)) {
      const picks = {};
      row.querySelectorAll(".chip[data-q]").forEach((b) =>
        b.addEventListener("click", () => {
          const qi = b.dataset.q;
          row.querySelectorAll(`.chip[data-q="${qi}"]`).forEach((x) => x.setAttribute("aria-pressed", "false"));
          b.setAttribute("aria-pressed", "true");
          picks[qi] = b.dataset.opt;
          const other = row.querySelector(`[data-other="${qi}"]`);
          if (other) other.value = "";
        }),
      );
      row.querySelector("[data-send]").addEventListener("click", () => {
        const answers = [];
        row.querySelectorAll("fieldset.question").forEach((fs) => {
          const qi = fs.dataset.qi;
          const typed = fs.querySelector(`[data-other="${qi}"]`).value.trim();
          const a = typed || picks[qi];
          if (a) answers.push(`- ${fs.querySelector("legend").textContent}: ${a}`);
        });
        const note = row.querySelector("[data-note]");
        if (!answers.length) {
          note.textContent = "Pick or type at least one answer.";
          return;
        }
        if (dialog) {
          // A live dialog: the agent's tool is waiting on exactly this answer.
          const typed = row.querySelector('[data-other="0"]').value.trim();
          this.answerDialog(tid, dialog.id, typed || picks["0"], row);
          return;
        }
        send(`Answers:\n${answers.join("\n")}`);
      });
      const skip = row.querySelector("[data-skip]");
      if (skip && dialog) skip.addEventListener("click", () => this.answerDialog(tid, dialog.id, null, row));
    },

    async answerDialog(tid, dialogId, value, row) {
      const note = row.querySelector("[data-note]");
      note.textContent = "Sending…";
      try {
        const r = await fetch(`/api/dialog/${encodeURIComponent(tid)}/${encodeURIComponent(dialogId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value === null ? { cancelled: true } : { value }),
        });
        const j = await r.json();
        if (j.ok) this.lockQuestion(row, "Sent");
        else {
          note.textContent = j.error || "Not sent.";
          if (r.status === 409) this.lockQuestion(row, "No longer waiting");
        }
      } catch {
        note.textContent = "Not sent; try again.";
      }
    },

    lockQuestion(row, label) {
      row.classList.add("is-answered");
      row.querySelectorAll("button, input").forEach((el) => (el.disabled = true));
      const note = row.querySelector("[data-note]");
      if (note) note.textContent = label;
    },

    markDialogAnswered(log, tid, ref, text) {
      const row = log.querySelector(`.bubble-row.is-question[data-thread="${CSS.escape(tid)}"][data-at="${CSS.escape(ref)}"]`);
      if (row) this.lockQuestion(row, `Answered: ${text}`);
    },

    /** Ephemeral events from live (rpc) agents: streaming text, tool steps, running state, notices. */
    onAgentEvent(ev, tid) {
      if (ev.kind === "stream") this.speakStream(tid, ev.text || "");
      const log = this.$refs.chatLog;
      const isCurrent = !this.chatGroup ? tid === this.chatId : true;
      if (ev.kind === "running") {
        if (isCurrent) this.chatThinking = ev.running;
        const t = this.findTarget(tid);
        if (t) t.thinking = ev.running;
        if (!ev.running && isCurrent) this.chatActivity = "";
        return;
      }
      if (ev.kind === "agent-status") return; // extension footer status (e.g. cursor:local); TUI chrome, not progress
      if (ev.kind === "activity") {
        if (isCurrent) this.chatActivity = ev.text || "";
        return;
      }
      if (!log) return;
      if (ev.kind === "stream") {
        let row = log.querySelector(`.bubble-row.is-streaming[data-thread="${CSS.escape(tid)}"]`);
        if (!ev.text) {
          if (row) row.remove();
          return;
        }
        if (!row) {
          const t = this.findTarget(tid) || { id: tid, label: tid, art: null };
          row = document.createElement("div");
          row.className = "d-chat d-chat-start bubble-row is-agent is-streaming";
          row.dataset.thread = tid;
          const face = t.art
            ? `<img class="avatar" src="${t.art}" alt="" width="48" height="48" />`
            : `<span class="avatar portrait-initials">${escapeHtml(this.initials(t))}</span>`;
          row.innerHTML = `${face}<div class="d-chat-bubble bubble"><span class="bubble-name">${escapeHtml(t.label || tid)} · writing</span><div class="md"></div></div>`;
          log.appendChild(row);
          this.chatEmpty = false;
        }
        row.querySelector(".md").innerHTML = renderMarkdown(ev.text);
        log.appendChild(row); // stay last
        log.scrollTop = log.scrollHeight;
        return;
      }
      if (ev.kind === "notice" && ev.text) {
        const row = document.createElement("div");
        row.className = `bubble-row is-system${ev.level === "error" ? " is-error" : ""}`;
        row.dataset.thread = tid;
        row.innerHTML = `<div class="bubble">${ev.level === "error" ? errorHtml(ev.text) : `<p>${escapeHtml(ev.text)}</p>`}</div>`;
        log.appendChild(row);
        log.scrollTop = log.scrollHeight;
      }
    },

    async stopAgent() {
      const t = this.current();
      if (!t || t.runtime !== "rpc") return;
      try {
        await fetch(`/api/agents/${encodeURIComponent(t.id)}/abort`, { method: "POST" });
      } catch {
        /* the running event will tell */
      }
    },

    async newAgentSession() {
      const t = this.current();
      if (!t || !t.persistentSession) return;
      if (!confirm(`Start ${t.label} on a fresh session? It forgets this conversation (the old session stays on disk).`)) return;
      let j = { ok: false, message: "Could not reach the dashboard." };
      try {
        const r = await fetch(`/api/agents/${encodeURIComponent(t.id)}/new-session`, { method: "POST" });
        j = await r.json();
      } catch {
        /* keep the fallback message */
      }
      this.appendChatLine({ role: "system", kind: "notice", text: j.message, ts: new Date().toISOString() }, t.id);
    },

    // ------------------------------------------------------------ voice

    /**
     * iPhones play sound only on an audio element first started inside a tap:
     * a new Audio() made after a fetch stays silent. So speech and
     * acknowledgements each reuse one element, unlocked by the first tap.
     */
    players() {
      if (!this._players) this._players = { ack: new Audio(), speech: new Audio() };
      return this._players;
    },

    unlockAudio() {
      if (this.audioUnlocked) return;
      this.audioUnlocked = true;
      // A tenth of a second of silence (16-bit mono WAV at 8 kHz).
      const n = 800;
      const buf = new ArrayBuffer(44 + n * 2);
      const v = new DataView(buf);
      const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
      str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
      const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
      for (const a of Object.values(this.players())) {
        a.src = url;
        a.play().then(() => a.pause()).catch(() => (this.audioUnlocked = false));
      }
    },

    /** Play a clip on one of the reusable players; resolves when it ends (or fails). */
    playOn(audio, blob) {
      return new Promise((resolve) => {
        const url = URL.createObjectURL(blob);
        const done = () => {
          audio.onended = audio.onerror = null;
          URL.revokeObjectURL(url);
          resolve();
        };
        audio.onended = done;
        audio.onerror = done;
        audio.src = url;
        audio.play().catch(done);
      });
    },

    /** Hold to talk (pointerdown/up); a quick click toggles instead. */
    micDown(ev) {
      this.micPointer = ev.pointerType;
      // On a touchscreen the mic is tap to talk (a held finger drifts, and iOS turns long presses into selection).
      if (ev.pointerType === "touch") return;
      ev.preventDefault();
      this.micHolding = true;
      this.micPressedAt = Date.now();
      if (this.voiceState === "listening") return;
      this.startListening();
    },

    micUp() {
      if (this.micPointer === "touch") return;
      this.micHolding = false;
      if (this.voiceState !== "listening") return;
      if (Date.now() - (this.micPressedAt || 0) < 350) {
        this.voiceNote = "Listening… click the mic again to send.";
        this.micToggled = true;
        return;
      }
      this.stopListening(true);
    },

    micClick() {
      this.unlockAudio();
      if (this.micPointer === "touch") {
        if (this.voiceState === "idle") this.voiceNote = "Listening… tap again to send, or just pause.";
        return this.toggleListening();
      }
      if (this.micToggled && this.voiceState === "listening" && Date.now() - (this.micPressedAt || 0) > 400) {
        this.micToggled = false;
        this.stopListening(true);
      }
    },

    toggleListening() {
      if (this.voiceState === "listening") this.stopListening(true);
      else if (this.voiceState === "idle") this.startListening();
    },

    async startListening() {
      // Barge-in: the captain talks over the agent. Stop now, and drop the rest of the reply that was being spoken.
      this.stopSpeaking();
      if (this.liveSpeech) this.liveSpeech.muted = true;
      this.voiceNote = "";
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === "suspended") await ctx.resume().catch(() => {});
        const src = ctx.createMediaStreamSource(stream);
        const node = ctx.createScriptProcessor(4096, 1, 1);
        const chunks = [];
        // End of speech: once the captain has spoken, about 1.3 s of quiet sends it (unless the mic is being held).
        let heard = false;
        let lastLoud = Date.now();
        node.onaudioprocess = (e) => {
          const d = e.inputBuffer.getChannelData(0);
          chunks.push(new Float32Array(d));
          let sum = 0;
          for (let i = 0; i < d.length; i += 4) sum += d[i] * d[i];
          if (Math.sqrt(sum / (d.length / 4)) > 0.015) {
            heard = true;
            lastLoud = Date.now();
          } else if (heard && !this.micHolding && Date.now() - lastLoud > 1300 && this.rec && this.rec.node === node) {
            this.stopListening(true);
          }
        };
        src.connect(node);
        node.connect(ctx.destination);
        this.rec = { stream, ctx, src, node, chunks, started: Date.now() };
        this.voiceState = "listening";
        if (!this.voiceNote) this.voiceNote = "Listening… release to send.";
        // Talking to an agent means wanting to hear it back.
        if (!this.voiceReplies) this.toggleVoiceReplies();
        this.recTimer = setTimeout(() => this.stopListening(true), 60_000);
      } catch (e) {
        this.voiceState = "idle";
        this.voiceNote = e && e.name === "NotAllowedError" ? "Microphone blocked. Allow it for this page in the browser." : "No microphone available.";
      }
    },

    async stopListening(send) {
      const r = this.rec;
      this.rec = null;
      clearTimeout(this.recTimer);
      this.micToggled = false;
      if (!r) return;
      try {
        r.node.disconnect();
        r.src.disconnect();
        r.stream.getTracks().forEach((t) => t.stop());
      } catch {
        /* already stopped */
      }
      const rate = r.ctx.sampleRate;
      r.ctx.close();
      if (!send || Date.now() - r.started < 400) {
        this.voiceState = "idle";
        this.voiceNote = send ? "Too short. Hold the mic while you speak." : "";
        return;
      }
      // Silence never leaves the page (transcribers invent text for it).
      let peak = 0, sum = 0, n = 0;
      for (const c of r.chunks) for (let i = 0; i < c.length; i += 8) { const a = Math.abs(c[i]); sum += a * a; n++; if (a > peak) peak = a; }
      if (Math.sqrt(sum / Math.max(1, n)) < 0.004 && peak < 0.05) {
        this.voiceState = "idle";
        this.voiceNote = "Didn't hear anything. Check the microphone.";
        return;
      }
      this.voiceState = "transcribing";
      this.voiceNote = "Transcribing…";
      const wav = encodeWav16k(r.chunks, rate);
      try {
        const res = await fetch("/api/voice/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
        const j = await res.json();
        if (!j.ok) throw new Error(j.message || "transcription failed");
        const text = (j.text || "").trim();
        if (!text) {
          this.voiceNote = "Didn't catch that.";
        } else if (this.voiceAnswer(text)) {
          this.voiceNote = `Answered by voice: “${text}”`;
          this.playAck(this.chatId);
        } else {
          this.voiceNote = "";
          this.chatDraft = text;
          this.sendChat();
          this.playAck(this.chatGroup ? this.groupTo : this.chatId);
        }
      } catch (e) {
        this.voiceNote = e.message || "Transcription failed.";
      }
      this.voiceState = "idle";
    },

    /**
     * A short spoken reply while a Go or a question waits in this chat answers
     * it, the same as clicking: "go" / "no", an option's words, "the second
     * one", "the recommended one", "yes" for a Yes/No question. Anything else,
     * or more than six words, goes out as a normal message.
     */
    voiceAnswer(text) {
      if (this.chatGroup || !this.$refs.chatLog) return false;
      if (text.trim().split(/\s+/).length > 6) return false;
      const norm = (s) =>
        String(s).toLowerCase().replace(/\(recommended\)|[—–-]\s*recommended/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
      const said = norm(text).replace(/^(please|uh|um|ok so|so)\s+/, "").replace(/\s+(please|thanks|thank you)$/, "");
      const YES_RE = /^(go|yes|yeah|yep|yup|ok|okay|sure|do it|go ahead|go for it|approve|approved|affirmative)$/;
      const NO_RE = /^(no|nope|nah|cancel|stop|don t|dont|do not|deny|decline|no thanks|negative)$/;
      // "yeah, go ahead" / "ok do it": a leading filler word does not change the answer.
      const core = (s) => s.replace(/^(yeah|yes|yep|ok|okay|sure|alright|all right|so|well)\s+/, "");
      const YES = { test: (s) => YES_RE.test(s) || YES_RE.test(core(s)) };
      const NO = { test: (s) => NO_RE.test(s) || NO_RE.test(core(s)) };
      const rows = [...this.$refs.chatLog.querySelectorAll(`.bubble-row.is-question[data-thread="${CSS.escape(this.chatId)}"]:not(.is-answered)`)];
      const row = rows.pop();
      if (!row) return false;
      if (row.classList.contains("is-go")) {
        const choice = YES.test(said) ? "go" : NO.test(said) ? "no" : "";
        const btn = choice && row.querySelector(`[data-go="${choice}"]:not([disabled])`);
        if (!btn) return false;
        btn.click();
        return true;
      }
      // Questions with options, one at a time (several questions in one block stay a click or a typed answer).
      if (row.querySelectorAll("fieldset.question").length !== 1) return false;
      const chips = [...row.querySelectorAll(".chip[data-opt]")];
      if (!chips.length) return false;
      const ORD = { one: 0, first: 0, "1": 0, two: 1, second: 1, "2": 1, three: 2, third: 2, "3": 2, four: 3, fourth: 3, "4": 3, five: 4, fifth: 4, "5": 4 };
      // "the second one", "option two", "number 2" → "second" / "two" / "2".
      let ord = said;
      for (let prev = ""; prev !== ord; ) {
        prev = ord;
        ord = ord.replace(/^(the|option|number)\s+/, "");
      }
      ord = ord.replace(/^(\S+)\s+(one|option)$/, "$1");
      let pick =
        chips.find((c) => norm(c.dataset.opt) === said) ||
        (ord in ORD ? chips[ORD[ord]] : undefined) ||
        (/^(the )?recommended( one)?$/.test(said) ? chips.find((c) => c.querySelector(".detent, .d-badge") || /recommended/i.test(c.dataset.opt)) : undefined) ||
        (YES.test(said) ? chips.find((c) => norm(c.dataset.opt) === "yes") : undefined) ||
        (NO.test(said) ? chips.find((c) => norm(c.dataset.opt) === "no") : undefined);
      // A unique option that starts with what was said ("tailwind" for "Tailwind and daisyUI").
      if (!pick && said.length >= 3) {
        const starts = chips.filter((c) => norm(c.dataset.opt).startsWith(said));
        if (starts.length === 1) pick = starts[0];
      }
      if (!pick) return false;
      pick.click();
      row.querySelector("[data-send]")?.click();
      return true;
    },

    /** Render this agent's acknowledgement lines ahead of time (Kokoro, cached as audio in the page). */
    async preloadAcks(agent) {
      if (!this.voiceReplies || !agent) return;
      this.ackCache ||= new Map();
      for (const line of ACK_LINES[agent] || ACK_LINES.default) {
        const key = `${agent}|${line}`;
        if (this.ackCache.has(key)) continue;
        this.ackCache.set(key, null); // in flight
        try {
          const r = await fetch("/api/voice/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent, text: line, part: 0 }) });
          if (r.status === 200) this.ackCache.set(key, await r.blob());
          else this.ackCache.delete(key);
        } catch {
          this.ackCache.delete(key);
        }
      }
    },

    /** A quick spoken acknowledgement, only when it is ready to play instantly (never delays anything). */
    playAck(agent) {
      if (!this.voiceReplies || !agent) return;
      const lines = ACK_LINES[agent] || ACK_LINES.default;
      const ready = lines.filter((l) => this.ackCache && this.ackCache.get(`${agent}|${l}`) && l !== this.lastAck);
      if (!ready.length) return void this.preloadAcks(agent);
      const line = ready[Math.floor(Math.random() * ready.length)];
      this.lastAck = line;
      const audio = this.players().ack;
      this.ackAudio = audio;
      this.ackDone = this.playOn(audio, this.ackCache.get(`${agent}|${line}`)).then(() => {
        if (this.ackAudio === audio) this.ackAudio = null;
      });
    },

    toggleVoiceReplies() {
      this.voiceReplies = !this.voiceReplies;
      this.voiceSince = Date.now();
      if (this.voiceReplies) this.preloadAcks(this.chatId);
      if (!this.voiceReplies) this.stopSpeaking();
      try {
        localStorage.setItem("fleet.voiceReplies", this.voiceReplies ? "1" : "0");
      } catch {
        /* private window */
      }
    },

    /**
     * Speak a live agent's reply sentence by sentence while it streams, so the
     * voice starts within a sentence instead of after the whole message.
     */
    speakStream(tid, text) {
      // With thinking hidden the live text may be narration: speak the saved answer instead (maybeSpeak).
      if (!this.showThinking) return;
      if (!this.voiceReplies || this.chatGroup || tid !== this.chatId || !text) return;
      const ls = this.liveSpeech;
      if (!ls || ls.tid !== tid || !text.startsWith(ls.raw.slice(0, ls.next))) {
        // A new message (the previous one ended or this is the first).
        this.liveSpeech = { tid, raw: text, next: 0, muted: this.voiceState !== "idle" };
      }
      const cur = this.liveSpeech;
      cur.raw = text;
      if (cur.done) return;
      const speak = (t) => !cur.muted && this.voiceState === "idle" && t.trim() && this.queueSpeech(tid, t);
      const { limit, cut } = spokenLimit(text, undefined, false);
      for (let c = speechChunk(text, cur.next); c && c.next <= limit; c = speechChunk(text, cur.next)) {
        cur.next = c.next;
        speak(c.chunk);
      }
      if (cut) {
        // A list, table, or code block started, or the opening ran past the budget: say the gist, not the whole reply.
        speak(text.slice(cur.next, limit));
        cur.next = limit;
        cur.done = true;
        speak(REST_ON_SCREEN);
      }
    },

    queueSpeech(agent, text) {
      (this.speechQueue ||= []).push({ agent, text });
      if (!this.voiceSpeaking) this.speakNext();
    },

    /** Speak an agent's chat line when voice replies are on and it arrived live. */
    maybeSpeak(m, threadId) {
      if (!this.voiceReplies || this.chatGroup || threadId !== this.chatId) return;
      if (m.step) return; // thinking is never read aloud
      if (m.role === "captain" || m.role === "system" || m.role === "dashboard" || (m.kind !== "chat" && m.kind !== "question")) return;
      if (!m.ts || Date.parse(m.ts) < this.voiceSince) return;
      // Questions are read whole (the captain answers them); replies give the gist (spokenLimit).
      const { limit, cut } = m.kind === "question" ? { limit: m.text.length, cut: false } : spokenLimit(m.text);
      const ls = this.liveSpeech;
      if (ls && ls.tid === threadId && ls.next > 0 && m.kind === "chat" && m.text.startsWith(ls.raw.slice(0, ls.next))) {
        // Part of this line was spoken while it streamed: say only what is left of the gist (nothing if the captain cut in).
        this.liveSpeech = null;
        if (ls.muted || ls.done || this.voiceState !== "idle") return;
        const rest = m.text.slice(ls.next, Math.max(ls.next, limit));
        if (rest.trim()) this.queueSpeech(threadId, rest);
        if (cut) this.queueSpeech(threadId, REST_ON_SCREEN);
        return;
      }
      if (this.voiceState !== "idle") return; // the captain is talking; don't start a reply over them
      this.queueSpeech(threadId, m.text.slice(0, limit));
      if (cut) this.queueSpeech(threadId, REST_ON_SCREEN);
    },

    async speakNext() {
      const item = (this.speechQueue || []).shift();
      if (!item) {
        this.voiceSpeaking = false;
        return;
      }
      this.voiceSpeaking = true;
      const gen = (this.speechGen = (this.speechGen || 0) + 1);
      const fetchPart = (part) =>
        fetch("/api/voice/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: item.agent, text: item.text, part }) });
      try {
        let res = await fetchPart(0);
        if (res.status === 503) return this.speakWithBrowser(item.text, gen);
        const total = Number(res.headers.get("X-Parts") || 0);
        for (let part = 0; part < total && gen === this.speechGen; part++) {
          if (res.status !== 200) break;
          const blob = await res.blob();
          const next = part + 1 < total ? fetchPart(part + 1) : null; // fetch ahead while this part plays
          await this.playBlob(blob, gen);
          if (!next) break;
          res = await next;
        }
      } catch {
        /* network hiccup; skip this line */
      }
      if (gen === this.speechGen) this.speakNext();
    },

    async playBlob(blob, gen) {
      // Let a playing acknowledgement finish first (it is about a second).
      if (this.ackDone) await this.ackDone;
      if (gen !== this.speechGen) return;
      this.speechAudio = this.players().speech;
      await this.playOn(this.speechAudio, blob);
    },

    /** Fallback when local voice is not set up: the browser's own speech. */
    speakWithBrowser(text, gen) {
      if (!window.speechSynthesis) return this.speakNext();
      const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/[*_`#>|]/g, "").slice(0, 1200);
      const u = new SpeechSynthesisUtterance(plain);
      u.onend = u.onerror = () => {
        if (gen === this.speechGen) this.speakNext();
      };
      speechSynthesis.speak(u);
    },

    stopSpeaking() {
      this.speechGen = (this.speechGen || 0) + 1;
      this.speechQueue = [];
      // Pause the players and settle their clips (a paused clip never fires "ended").
      for (const a of [this.ackAudio, this.speechAudio]) {
        if (!a) continue;
        a.pause();
        if (a.onended) a.onended();
      }
      this.ackAudio = null;
      this.ackDone = null;
      this.speechAudio = null;
      if (window.speechSynthesis) speechSynthesis.cancel();
      this.voiceSpeaking = false;
    },

    /** A captain line after a question means it was answered; lock the buttons. */
    markAnswered(log, tid, ts) {
      log.querySelectorAll(`.bubble-row.is-question[data-thread="${CSS.escape(tid)}"]:not(.is-answered):not([data-dialog])`).forEach((r) => {
        if (!r.dataset.at || r.dataset.at >= ts) return;
        r.classList.add("is-answered");
        r.querySelectorAll("button, input").forEach((el) => (el.disabled = true));
        const note = r.querySelector("[data-note]");
        if (note) note.textContent = "Answered";
      });
    },

    /** Auto target: ask Jev who owns the message, then send it there. */
    async routeAndSend() {
      const text = this.chatDraft.trim();
      if (!text || this.routing) return;
      this.routing = true;
      this.routeNote = "Asking Jev who should take this…";
      this.routeChoices = [];
      try {
        const r = await fetch("/api/route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        const j = await r.json();
        if (j.status === "clear" && j.target) {
          this.routeNote = `Jev: ${this.choiceLabel(j.choice)} (${Math.round((j.confidence || 0) * 100)}%)`;
          this.sendRouted(j.target, j.sendTo);
          return;
        }
        const why = j.status === "off" ? `Jev routing is off: ${j.reason}` : j.reason || j.status;
        this.routeNote = `${why}. Pick where this goes:`;
        this.routeChoices = (j.probabilities || [])
          .filter((c) => c.key !== "ask")
          .slice(0, 4)
          .map((c) => ({ ...c, label: this.choiceLabel(c.key) }));
        if (!this.routeChoices.length) {
          this.routeChoices = this.rail.agents
            .map((a) => ({ key: a.kind === "firstmate" ? "firstmate" : "agent_" + a.id, label: a.label }))
            .concat(this.groups.map((g) => ({ key: "group_" + g.id, label: g.name + " (group)" })));
        }
      } catch {
        this.routeNote = "Routing failed. Pick a face on the rail.";
      } finally {
        this.routing = false;
      }
    },

    choiceLabel(key) {
      if (key === "firstmate") return "Firstmate";
      if (key && key.startsWith("group_")) {
        const g = this.groups.find((x) => x.id === key.slice(6));
        return g ? `${g.name} (lead ${g.lead})` : key.slice(6);
      }
      return key ? key.replace(/^agent_/, "") : "";
    },

    pickRoute(key) {
      if (key === "firstmate") return this.sendRouted("firstmate", "firstmate");
      if (key.startsWith("group_")) {
        const g = this.groups.find((x) => x.id === key.slice(6));
        if (g) return this.sendRouted("group:" + g.id, g.lead);
      }
      const id = key.replace(/^agent_/, "");
      this.sendRouted("agent:" + id, id);
    },

    sendRouted(target, sendTo) {
      this.routeChoices = [];
      this.autoRoute = false;
      if (target.startsWith("group:")) {
        this.openGroup(target.slice(6));
        if (sendTo) this.groupTo = sendTo;
      } else {
        this.openChat(sendTo);
      }
      // Sockets for the new thread are still opening; sendChat falls back to POST.
      this.$nextTick(() => this.sendChat());
    },

    sendChat() {
      if (this.autoRoute) return this.routeAndSend();
      const text = this.chatDraft.trim();
      if (!text) return;
      this.sendText(this.current().id, text);
      this.chatDraft = "";
      this.growComposer();
    },

    // Enter sends; Shift+Enter (or Enter while an IME is composing) adds a line.
    composerEnter(ev) {
      if (ev.shiftKey || ev.isComposing || ev.keyCode === 229) return;
      ev.preventDefault();
      ev.target.form?.requestSubmit();
    },

    growComposer() {
      this.$nextTick(() => {
        const field = this.$refs.chatField;
        if (!field) return;
        field.style.height = "auto";
        field.style.height = Math.min(field.scrollHeight + 2, 200) + "px";
      });
    },

    /** Your message, shown at once as "sending…" until the server's copy replaces it. */
    showSending(to, text, requestId) {
      const log = this.$refs.chatLog;
      if (!log || (this.chatGroup ? !this.chatGroup.members.includes(to) : to !== this.chatId)) return;
      this.chatEmpty = false;
      const row = document.createElement("div");
      row.className = "d-chat d-chat-end bubble-row is-captain is-sending";
      row.dataset.request = requestId;
      row.dataset.thread = to;
      row.innerHTML = `<img class="avatar" src="/art/captain.png" alt="" width="48" height="48" /><div class="d-chat-bubble bubble"><span class="bubble-name">You</span><div class="md">${renderMarkdown(text)}</div></div>`;
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
      // No echo in 12s: say so, with Retry (the same id, so it can never send twice).
      setTimeout(() => {
        if (!row.isConnected || !row.classList.contains("is-sending")) return;
        row.classList.replace("is-sending", "is-unsent");
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "btn";
        retry.textContent = "Retry";
        retry.addEventListener("click", () => {
          row.remove();
          this.sendText(to, text, requestId);
        });
        row.querySelector(".bubble").appendChild(retry);
      }, 12_000);
    },

    badgeText(ship) {
      return (shipBadge(ship) || {}).text || "";
    },

    badgeStyle(ship) {
      const b = shipBadge(ship);
      return b ? `--badge:${b.color}` : "";
    },

    /** A face with its ship badge (crewmates), for cards built in JS. */
    faceHtml(t, size = 48) {
      const img = t.art
        ? `<img class="avatar" src="${t.art}" alt="" width="${size}" height="${size}" />`
        : `<span class="avatar portrait-initials">${escapeHtml(this.initials(t))}</span>`;
      const b = shipBadge(t.ship);
      return b ? `<span class="face-wrap">${img}<span class="ship-badge" style="--badge:${b.color}" aria-hidden="true">${escapeHtml(b.text)}</span></span>` : img;
    },

    activityIcon() {
      const a = String(this.chatActivity || "").toLowerCase();
      if (/^(read|grep|find|ls|glob)\b/.test(a)) return "▤";
      if (/^(edit|write|apply)/.test(a)) return "✎";
      if (/^bash\b/.test(a)) return "›_";
      if (/browser|screenshot|playwright|chrome|canvas/.test(a)) return "◎";
      if (/^(fleet_|ship_|voyage_|crew_|order_|agent_)/.test(a)) return "⚓";
      return "⚙";
    },

    sendText(to, text, reuseId) {
      const t = this.findTarget(to) || { id: to, kind: "headless" };
      if (t.kind !== "firstmate" && t.kind !== "task") this.chatThinking = true;
      // One id per message: the server sends it at most once, so retries are safe.
      const requestId = reuseId || crypto.randomUUID();
      this.showSending(to, text, requestId);
      const ws = this.chatSockets[to];
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ text, requestId }));
        return;
      }
      const post = (attempt) =>
        fetch("/chat/" + encodeURIComponent(to), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, requestId }),
        })
          .then((r) => r.json())
          .then((j) => {
            if (j.line) this.appendChatLine({ role: "captain", kind: "chat", text: j.line.text, ts: j.line.ts, requestId: j.line.requestId || requestId }, to);
            if (!j.ok) this.chatThinking = false;
          })
          .catch(() => {
            // Network trouble (a phone between cells): try again with the same id.
            if (attempt < 3) setTimeout(() => post(attempt + 1), 800 * 2 ** attempt);
            else this.chatThinking = false;
          });
      post(0);
    },
  };
}

/** "just now", "4m ago", "3h ago", "2d ago". */
function agoText(ts) {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** An error bubble's body: one readable sentence, the raw text folded away. */
function errorHtml(text) {
  const e = humanizeError(text);
  return `<p>${escapeHtml(e.summary)}</p>${e.folded ? `<details class="raw"><summary>Details</summary><pre>${escapeHtml(e.raw)}</pre></details>` : ""}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

document.addEventListener("alpine:init", () => {
  Alpine.data("dashboardApp", dashboardApp);
});
