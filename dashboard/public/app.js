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
    chatGen: 0,

    paletteItems() {
      const base = [
        { id: "health", label: "Go to Health", run: () => this.openLeaf("health") },
        { id: "fleet", label: "Go to Fleet", run: () => this.openLeaf("fleet") },
        { id: "agents", label: "Go to Agents", run: () => this.openLeaf("agents") },
      ];
      const chats = this.rail.agents
        .concat(this.rail.workers)
        .map((t) => ({ id: "chat-" + t.id, label: "Chat with " + t.label, run: () => this.openChat(t.id) }));
      return base.concat(chats, this.chatOpen ? [{ id: "chat-close", label: "Close chat", run: () => this.closeChat() }] : []);
    },

    init() {
      this.refreshRail();
      this.refreshAgentStatus();
      this.connectBus();
      const m = location.hash.match(/^#chat\/([a-z][a-z0-9_-]*)$/);
      if (m) this.openChat(m[1]);
      else if (location.hash === "#alice") this.openChat("alice");
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
        const r = await fetch("/api/chat-targets");
        const j = await r.json();
        this.rail = { agents: j.agents || [], workers: j.workers || [] };
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
      return this.findTarget(this.chatId) || { id: this.chatId, label: this.chatId, art: null };
    },

    initials(t) {
      const words = String((t && (t.label || t.id)) || "?").replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/);
      return ((words[0] || "?")[0] + (words[1] ? words[1][0] : (words[0] || "")[1] || "")).toUpperCase();
    },

    chatMeta() {
      const t = this.current();
      if (t.kind === "task") return [t.state, t.project].filter(Boolean).join(" · ");
      if (t.kind === "firstmate") return "fm-send → TUI";
      const turn = t.lastTurn ? ` · last turn ${t.lastTurn.status} ${t.lastTurn.ms}ms` : "";
      return (t.model || "") + turn;
    },

    toggleChat() {
      if (this.chatOpen) this.closeChat();
      else this.openChat(this.chatId);
    },

    openChat(id) {
      this.closePalette();
      const switching = id !== this.chatId || !this.chatWs;
      this.chatId = id;
      saveChatId(id);
      this.chatOpen = true;
      if (switching) this.connectChat();
      this.$nextTick(() => {
        const field = this.$refs.chatField;
        if (field) field.focus();
      });
    },

    closeChat() {
      this.chatOpen = false;
    },

    connectChat() {
      const gen = ++this.chatGen;
      if (this.chatWs) {
        this.chatWs.onclose = null;
        try { this.chatWs.close(); } catch { /* gone */ }
      }
      const log = this.$refs.chatLog;
      if (log) log.querySelectorAll(".bubble-row:not([x-show])").forEach((n) => n.remove());
      this.chatEmpty = true;
      this.chatThinking = false;
      this.chatConn = "connecting";
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const id = this.chatId;
      const ws = new WebSocket(`${proto}//${location.host}/ws/chat/${encodeURIComponent(id)}`);
      this.chatWs = ws;
      ws.onopen = () => {
        if (gen === this.chatGen) this.chatConn = "open";
      };
      ws.onclose = () => {
        if (gen !== this.chatGen) return;
        this.chatConn = this.findTarget(id) ? "closed" : "not on the rail";
        this.chatWs = null;
        if (this.findTarget(id)) setTimeout(() => { if (gen === this.chatGen) this.connectChat(); }, 4000);
      };
      ws.onmessage = (ev) => {
        if (gen !== this.chatGen) return;
        try {
          const m = JSON.parse(ev.data);
          if (m.error) return;
          if (m.role !== "captain") this.chatThinking = false;
          this.appendChatLine(m);
        } catch {
          /* ignore */
        }
      };
    },

    appendChatLine(m) {
      const log = this.$refs.chatLog;
      if (!log) return;
      this.chatEmpty = false;
      const t = this.current();
      const row = document.createElement("div");
      if (m.kind === "error") {
        row.className = "bubble-row is-system is-error";
        row.innerHTML = `<div class="bubble"><span class="bubble-name">Not sent</span><p>${escapeHtml(m.text)}</p></div>`;
        const target = m.ref ? log.querySelector(`[data-ts="${CSS.escape(m.ref)}"]`) : null;
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
        const face = mine ? "/art/captain.png" : t.art;
        const name = mine ? "You" : t.label || m.role;
        const avatar = face
          ? `<img class="avatar" src="${face}" alt="" width="48" height="48" />`
          : `<span class="avatar portrait-initials">${escapeHtml(this.initials(t))}</span>`;
        row.innerHTML = `${avatar}<div class="bubble"><span class="bubble-name">${escapeHtml(name)}</span><p>${escapeHtml(m.text)}</p></div>`;
      }
      log.appendChild(row);
      while (log.childElementCount > LOG_MAX) log.removeChild(log.firstChild);
      log.scrollTop = log.scrollHeight;
    },

    sendChat() {
      const text = this.chatDraft.trim();
      if (!text) return;
      const t = this.current();
      if (t.kind !== "firstmate" && t.kind !== "task") this.chatThinking = true;
      if (this.chatWs && this.chatWs.readyState === WebSocket.OPEN) {
        this.chatWs.send(text);
      } else {
        fetch("/chat/" + encodeURIComponent(this.chatId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        })
          .then((r) => r.json())
          .then((j) => {
            if (j.line) this.appendChatLine({ role: "captain", kind: "chat", text: j.line.text, ts: j.line.ts });
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
