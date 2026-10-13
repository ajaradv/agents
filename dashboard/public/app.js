const LOG_MAX = 80;
const CHAT_KEY = "fleet.chatId";

function readChatId() {
  try {
    return localStorage.getItem(CHAT_KEY) || "alice";
  } catch {
    return "alice";
  }
}

const LEAVES = ["harbor", "health", "fleet", "agents"];

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
    bus: null,

    rail: { agents: [], workers: [] },
    chatOpen: false,
    chatId: readChatId(),
    chatEmpty: true,
    chatDraft: "",
    /** Voice: "idle" | "listening" | "transcribing"; replies are spoken when voiceReplies is on. */
    voiceState: "idle",
    voiceReplies: false,
    voiceSpeaking: false,
    voiceNote: "",
    chatConn: "",
    chatThinking: false,
    chatActivity: "",
    canvasItems: [],
    canvasSel: "",
    canvasOpen: false,
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
        { id: "harbor", label: "Go to Harbor", run: () => this.openLeaf("harbor") },
        { id: "health", label: "Go to Health", run: () => this.openLeaf("health") },
        { id: "fleet", label: "Go to Fleet", run: () => this.openLeaf("fleet") },
        { id: "agents", label: "Go to Agents", run: () => this.openLeaf("agents") },
      ];
      const chats = this.rail.agents
        .concat(this.rail.workers)
        .map((t) => ({ id: "chat-" + t.id, label: "Chat with " + t.label, run: () => this.openChat(t.id) }));
      const groupItems = this.groups.map((g) => ({ id: "group-" + g.id, label: "Open group " + g.name, run: () => this.openGroup(g.id) }));
      return base.concat(chats, groupItems, this.chatOpen ? [{ id: "chat-close", label: "Close chat", run: () => this.closeChat() }] : []);
    },

    init() {
      try {
        this.voiceReplies = localStorage.getItem("fleet.voiceReplies") === "1";
      } catch {
        /* private window */
      }
      this.voiceSince = Date.now();
      this.refreshRail();
      this.refreshAgentStatus();
      this.connectBus();
      this.applyUrl();
      // Old hash links (#chat/<id>, #group/<id>, #alice) still open their drawer.
      const m = location.hash.match(/^#chat\/([a-z][a-z0-9_-]*)$/);
      if (m) this.openChat(m[1]);
      else if (location.hash === "#alice") this.openChat("alice");
      const g = location.hash.match(/^#group\/([a-z][a-z0-9-]*)$/);
      if (g) this.refreshRail().then(() => this.openGroup(g[1]));
      this.$watch("chatOpen", () => this.syncUrl());
      this.$watch("chatId", () => this.syncUrl());
      this.$watch("chatGroup", () => this.syncUrl());
      window.addEventListener("popstate", () => this.applyUrl());
      document.body.addEventListener("htmx:afterSettle", (ev) => {
        const elt = ev.detail?.elt || ev.target;
        if (window.Alpine && elt) Alpine.initTree(elt);
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

    /** /health, /fleet, /agents pick the section; ?chat=<id> or ?group=<id> opens the drawer. */
    applyUrl() {
      const leaf = location.pathname.replace(/^\/+|\/+$/g, "");
      const ship = leaf.match(/^ships\/([a-z][a-z0-9_-]{0,63})$/);
      this.shipSel = ship ? ship[1] : "";
      this.leaf = ship ? "harbor" : LEAVES.includes(leaf) ? leaf : "harbor";
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
      const base = this.leaf === "harbor" && this.shipSel ? `/ships/${encodeURIComponent(this.shipSel)}` : `/${this.leaf}`;
      return `${base}${q}`;
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
      this.$nextTick(() => this.pull(this.shipSel ? `/partials/ship/${encodeURIComponent(this.shipSel)}` : "/partials/harbor", "#harbor-view"));
    },

    openShip(id) {
      this.closePalette();
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
        const r = await fetch(form.dataset.api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
      es.addEventListener("rail", () => this.refreshRail());
      // The ship's log moved, or crew came and went: refresh what the harbor shows.
      const harborRefresh = (ship) => {
        if (this.leaf !== "harbor" || document.hidden) return;
        if (!this.shipSel || !ship || ship === this.shipSel) this.loadHarbor();
      };
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
        htmx.ajax("GET", url, { target, swap: "innerHTML" });
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
        this.groups = (await rg.json()).groups || [];
        if (this.chatGroup) this.chatGroup = this.groups.find((g) => g.id === this.chatGroup.id) || null;
        const cur = this.findTarget(this.chatId);
        if (cur && cur.kind !== "firstmate" && cur.kind !== "task") this.chatThinking = Boolean(cur.thinking);
      } catch {
        /* keep last */
      }
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
      if (t.kind === "firstmate") return "fm-send → TUI";
      const turn = t.lastTurn ? ` · last turn ${t.lastTurn.status} ${t.lastTurn.ms}ms` : "";
      return (t.model || "") + turn;
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
      if (switching) {
        this.connectThreads([id]);
        this.canvasItems = [];
        this.canvasOpen = false;
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
          this.canvasOpen = true;
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

    toggleCanvas() {
      this.canvasOpen = !this.canvasOpen;
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

    appendChatLine(m, threadId) {
      const log = this.$refs.chatLog;
      if (!log) return;
      this.chatEmpty = false;
      const tid = threadId || this.chatId;
      // Replays and live events repeat lines; ts + kind identifies one (an answer and
      // the follow-up dialog it opens can share a millisecond).
      const kind = m.kind || "chat";
      if (m.ts && log.querySelector(`[data-at="${CSS.escape(m.ts)}"][data-kind="${CSS.escape(kind)}"][data-thread="${CSS.escape(tid)}"]`)) return;
      const t = this.findTarget(tid) || { id: tid, label: tid, art: null };
      const row = document.createElement("div");
      if (m.kind === "error") {
        row.className = "bubble-row is-system is-error";
        row.innerHTML = `<div class="bubble"><span class="bubble-name">Not sent</span><p>${escapeHtml(m.text)}</p></div>`;
        const target = m.ref ? log.querySelector(`[data-ts="${CSS.escape(m.ref)}"][data-thread="${CSS.escape(tid)}"]`) : null;
        if (target) {
          target.classList.add("is-failed");
          target.after(row);
          return;
        }
      } else if (m.kind === "question" && Array.isArray(m.questions) && m.questions.length) {
        row.className = "bubble-row is-agent is-question";
        const face = t.art
          ? `<img class="avatar" src="${t.art}" alt="" width="48" height="48" />`
          : `<span class="avatar portrait-initials">${escapeHtml(this.initials(t))}</span>`;
        row.innerHTML = `${face}<div class="bubble question-block">
          <span class="bubble-name">${escapeHtml(t.label || m.role)} asks</span>
          ${this.questionsHtml(m)}
          <div class="row question-actions"><button type="button" class="btn btn-ink" data-send>${m.dialog ? "Send answer" : "Send answers"}</button>${m.dialog ? '<button type="button" class="btn" data-skip>Skip</button>' : ""}<span class="muted" data-note></span></div>
        </div>`;
        if (m.dialog) row.dataset.dialog = m.dialog.id;
        this.wireQuestion(row, tid, m.dialog);
      } else if (m.kind === "answer") {
        row.className = "bubble-row is-captain is-answer";
        row.innerHTML = `<div class="bubble"><span class="bubble-name">You answered</span><p>${escapeHtml(m.text)}</p></div>`;
        if (m.ref) this.markDialogAnswered(log, tid, m.ref, m.text);
      } else if (m.kind === "crew") {
        // A crewmate wrote to this agent (lead ↔ crew); show who, not the thread's agent.
        const from = this.findTarget(m.role) || { id: m.role, label: m.role, art: null };
        row.className = "bubble-row is-agent is-crew";
        const face = from.art
          ? `<img class="avatar" src="${from.art}" alt="" width="48" height="48" />`
          : `<span class="avatar portrait-initials">${escapeHtml(this.initials(from))}</span>`;
        row.innerHTML = `${face}<div class="bubble"><span class="bubble-name">${escapeHtml(from.label)} → ${escapeHtml(t.label || tid)}</span><p>${escapeHtml(m.text)}</p></div>`;
      } else if (m.role === "system" || m.role === "dashboard") {
        row.className = "bubble-row is-system";
        row.innerHTML = `<div class="bubble"><p>${escapeHtml(m.text)}</p></div>`;
      } else {
        const mine = m.role === "captain";
        row.className = `bubble-row is-${mine ? "captain" : "agent"}`;
        if (m.ts) row.dataset.ts = m.ts;
        row.dataset.thread = tid;
        const face = mine ? "/art/captain.png" : t.art;
        const to = this.chatGroup ? ` → ${t.label}` : "";
        const name = mine ? "You" + to : t.label || m.role;
        const avatar = face
          ? `<img class="avatar" src="${face}" alt="" width="48" height="48" />`
          : `<span class="avatar portrait-initials">${escapeHtml(this.initials(t))}</span>`;
        row.innerHTML = `${avatar}<div class="bubble"><span class="bubble-name">${escapeHtml(name)}</span><p>${escapeHtml(m.text)}</p></div>`;
      }
      if (m.ts) row.dataset.at = m.ts;
      row.dataset.kind = kind;
      row.dataset.thread = tid;
      if (m.role === "captain" && m.ts) this.markAnswered(log, tid, m.ts);
      // Stacked group threads replay one member at a time; keep the drawer in time order.
      const later = m.ts ? [...log.querySelectorAll(".bubble-row[data-at]")].find((n) => n.dataset.at > m.ts) : null;
      if (later) log.insertBefore(row, later);
      else log.appendChild(row);
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
                `<button type="button" class="chip" data-q="${qi}" data-opt="${escapeHtml(o)}" aria-pressed="false">${escapeHtml(o)}${o === q.recommended ? ' <span class="detent">recommended</span>' : ""}</button>`,
            )
            .join("");
          return `<fieldset class="question" data-qi="${qi}">
            <legend>${escapeHtml(q.question)}</legend>
            <div class="row-wrap">${opts}</div>
            <input class="field" data-other="${qi}" placeholder="${opts ? "Or type another answer" : "Your answer"}" aria-label="${escapeHtml(q.question)}" />
          </fieldset>`;
        })
        .join("");
      return `${intro ? `<p>${escapeHtml(intro)}</p>` : ""}${qs}`;
    },

    wireQuestion(row, tid, dialog) {
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
        this.sendText(tid, `Answers:\n${answers.join("\n")}`);
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
        if (!j.ok) {
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
          row.className = "bubble-row is-agent is-streaming";
          row.dataset.thread = tid;
          const face = t.art
            ? `<img class="avatar" src="${t.art}" alt="" width="48" height="48" />`
            : `<span class="avatar portrait-initials">${escapeHtml(this.initials(t))}</span>`;
          row.innerHTML = `${face}<div class="bubble"><span class="bubble-name">${escapeHtml(t.label || tid)} · writing</span><p></p></div>`;
          log.appendChild(row);
          this.chatEmpty = false;
        }
        row.querySelector("p").textContent = ev.text;
        log.appendChild(row); // stay last
        log.scrollTop = log.scrollHeight;
        return;
      }
      if (ev.kind === "notice" && ev.text) {
        const row = document.createElement("div");
        row.className = `bubble-row is-system${ev.level === "error" ? " is-error" : ""}`;
        row.dataset.thread = tid;
        row.innerHTML = `<div class="bubble"><p>${escapeHtml(ev.text)}</p></div>`;
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

    /** Hold to talk (pointerdown/up); a quick click toggles instead. */
    micDown(ev) {
      ev.preventDefault();
      this.micPressedAt = Date.now();
      if (this.voiceState === "listening") return;
      this.startListening();
    },

    micUp() {
      if (this.voiceState !== "listening") return;
      if (Date.now() - (this.micPressedAt || 0) < 350) {
        this.voiceNote = "Listening… click the mic again to send.";
        this.micToggled = true;
        return;
      }
      this.stopListening(true);
    },

    micClick() {
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
      this.stopSpeaking();
      this.voiceNote = "";
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const src = ctx.createMediaStreamSource(stream);
        const node = ctx.createScriptProcessor(4096, 1, 1);
        const chunks = [];
        node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        src.connect(node);
        node.connect(ctx.destination);
        this.rec = { stream, ctx, src, node, chunks, started: Date.now() };
        this.voiceState = "listening";
        if (!this.voiceNote) this.voiceNote = "Listening… release to send.";
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
        } else {
          this.voiceNote = "";
          this.chatDraft = text;
          this.sendChat();
        }
      } catch (e) {
        this.voiceNote = e.message || "Transcription failed.";
      }
      this.voiceState = "idle";
    },

    toggleVoiceReplies() {
      this.voiceReplies = !this.voiceReplies;
      this.voiceSince = Date.now();
      if (!this.voiceReplies) this.stopSpeaking();
      try {
        localStorage.setItem("fleet.voiceReplies", this.voiceReplies ? "1" : "0");
      } catch {
        /* private window */
      }
    },

    /** Speak an agent's chat line when voice replies are on and it arrived live. */
    maybeSpeak(m, threadId) {
      if (!this.voiceReplies || this.chatGroup || threadId !== this.chatId) return;
      if (m.role === "captain" || m.role === "system" || m.role === "dashboard" || (m.kind !== "chat" && m.kind !== "question")) return;
      if (!m.ts || Date.parse(m.ts) < this.voiceSince) return;
      (this.speechQueue ||= []).push({ agent: threadId, text: m.text });
      if (!this.voiceSpeaking) this.speakNext();
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

    playBlob(blob, gen) {
      return new Promise((resolve) => {
        if (gen !== this.speechGen) return resolve();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        this.speechAudio = audio;
        const done = () => {
          URL.revokeObjectURL(url);
          resolve();
        };
        audio.onended = done;
        audio.onerror = done;
        audio.play().catch(done);
      });
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
      if (this.speechAudio) {
        this.speechAudio.pause();
        this.speechAudio = null;
      }
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

    sendText(to, text) {
      const t = this.findTarget(to) || { id: to, kind: "headless" };
      if (t.kind !== "firstmate" && t.kind !== "task") this.chatThinking = true;
      const ws = this.chatSockets[to];
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(text);
      } else {
        fetch("/chat/" + encodeURIComponent(to), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        })
          .then((r) => r.json())
          .then((j) => {
            if (j.line) this.appendChatLine({ role: "captain", kind: "chat", text: j.line.text, ts: j.line.ts }, to);
            if (!j.ok) this.chatThinking = false;
          })
          .catch(() => {
            this.chatThinking = false;
          });
      }
    },
  };
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
