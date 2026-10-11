const LOG_MAX = 80;
const CHAT_KEY = "fleet.chatId";

function readChatId() {
  try {
    return localStorage.getItem(CHAT_KEY) || "alice";
  } catch {
    return "alice";
  }
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
    leaf: "health",
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
    chatConn: "",
    chatThinking: false,
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
      this.refreshRail();
      this.refreshAgentStatus();
      this.connectBus();
      const m = location.hash.match(/^#chat\/([a-z][a-z0-9_-]*)$/);
      if (m) this.openChat(m[1]);
      else if (location.hash === "#alice") this.openChat("alice");
      const g = location.hash.match(/^#group\/([a-z][a-z0-9-]*)$/);
      if (g) this.refreshRail().then(() => this.openGroup(g[1]));
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
      if (!this.paletteOpen) {
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

    openLeaf(id) {
      this.chatOpen = false;
      this.closePalette();
      this.leaf = id;
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
      if (switching) this.connectThreads([id]);
      this.focusComposer();
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
          if (m.role !== "captain") this.chatThinking = false;
          this.appendChatLine(m, id);
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
      if (m.ts && log.querySelector(`[data-at="${CSS.escape(m.ts)}"][data-thread="${CSS.escape(tid)}"]`)) return;
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
      row.dataset.thread = tid;
      // Stacked group threads replay one member at a time; keep the drawer in time order.
      const later = m.ts ? [...log.querySelectorAll(".bubble-row[data-at]")].find((n) => n.dataset.at > m.ts) : null;
      if (later) log.insertBefore(row, later);
      else log.appendChild(row);
      while (log.childElementCount > LOG_MAX) log.removeChild(log.firstChild);
      if (!later) log.scrollTop = log.scrollHeight;
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
      const t = this.current();
      const to = t.id;
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
      this.chatDraft = "";
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
