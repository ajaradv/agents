const LOG_MAX = 80;

const AGENT_AVATAR = {
  alice: "/art/alice.png",
  firstmate: "/art/firstmate.png",
  architect: "/art/architect.png",
};

function agentAvatar(id) {
  return AGENT_AVATAR[id] || "/art/alice.png";
}

function dashboardApp() {
  return {
    leaf: "health",
    hinge: "",
    aliceOpen: false,
    aliceEmpty: true,
    paletteOpen: false,
    paletteIndex: 0,
    selectedAgent: null,
    spaceHtml: "",
    aliceDraft: "",
    aliceConn: "connecting",
    aliceSession: "",
    aliceThinking: false,
    aliceWs: null,
    waiting: false,
    waitSummary: "",
    bus: null,

    paletteItems() {
      return [
        { id: "health", label: "Go to Health", run: () => this.openLeaf("health") },
        { id: "fleet", label: "Go to Fleet", run: () => this.openLeaf("fleet") },
        { id: "agents", label: "Go to Agents", run: () => this.openLeaf("agents") },
        { id: "alice-open", label: "Open Alice chat", run: () => this.openAlice() },
        { id: "alice-close", label: "Close Alice chat", run: () => this.closeAlice() },
      ];
    },

    init() {
      this.connectAlice();
      this.refreshAgentStatus();
      this.connectBus();
      if (location.hash === "#alice") this.openAlice();
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
        if (ev.key === "Escape" && this.aliceOpen) {
          ev.preventDefault();
          this.closeAlice();
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
      this.aliceOpen = false;
      this.closePalette();
      this.leaf = id;
      this.hinge = id;
      window.setTimeout(() => {
        if (this.hinge === id) this.hinge = "";
      }, 100);
    },

    toggleAlice() {
      if (this.aliceOpen) this.closeAlice();
      else this.openAlice();
    },

    openAlice() {
      this.closePalette();
      this.aliceOpen = true;
      this.$nextTick(() => {
        const field = this.$refs.aliceField;
        if (field) field.focus();
      });
    },

    closeAlice() {
      this.aliceOpen = false;
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
      });
    },

    pull(url, target) {
      if (window.htmx) {
        htmx.ajax("GET", url, { target, swap: "innerHTML" });
      }
    },

    async selectAgent(id) {
      this.selectedAgent = id;
      this.openLeaf("agents");
      const r = await fetch("/partials/space/" + id);
      this.spaceHtml = await r.text();
      this.$nextTick(() => {
        const root = document.getElementById("agent-space");
        if (window.Alpine && root) Alpine.initTree(root);
      });
    },

    async refreshAgentStatus() {
      try {
        const r = await fetch("/api/agents");
        const j = await r.json();
        const agents = j.agents || [];
        const alice = agents.find((a) => a.id === "alice");
        const waiting = agents.find((a) => a.waitingOnYou);
        this.waiting = Boolean(waiting);
        this.waitSummary = waiting
          ? `Waiting on you: ${waiting.firstmateWaitSummary || waiting.id}`
          : "";
        if (!alice) {
          this.aliceSession = "";
          return;
        }
        const tui = alice.tuiLabel || "TUI off";
        const chat = alice.chatLabel || "chat";
        const turn = alice.lastChatTurn
          ? ` · last turn ${alice.lastChatTurn.status} ${alice.lastChatTurn.ms}ms`
          : "";
        const tuiMsg =
          alice.tuiState === "error" && alice.tuiMessage
            ? ` — ${alice.tuiMessage}`
            : "";
        this.aliceSession = `${chat} · ${tui}${turn}${tuiMsg}`;
        this.aliceThinking = alice.chatState === "thinking";
      } catch {
        this.aliceSession = "";
      }
    },

    connectAlice() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/ws/chat/alice`);
      this.aliceWs = ws;
      ws.onopen = () => {
        this.aliceConn = "open";
      };
      ws.onclose = () => {
        this.aliceConn = "closed";
        setTimeout(() => this.connectAlice(), 4000);
      };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.error) return;
          if (m.role === "alice" || m.role === "system") {
            this.aliceThinking = false;
          }
          this.appendAliceLine(m.role, m.text, m.ts);
        } catch {
          /* ignore */
        }
      };
    },

    appendAliceLine(role, text) {
      const log = this.$refs.aliceLog;
      if (!log) return;
      this.aliceEmpty = false;
      const kind = role === "captain" ? "captain" : role === "system" ? "system" : "alice";
      const row = document.createElement("div");
      row.className = `bubble-row is-${kind}`;
      if (kind === "system") {
        row.innerHTML = `<div class="bubble"><p>${escapeHtml(text)}</p></div>`;
      } else {
        const face = kind === "captain" ? "/art/captain.png" : "/art/alice.png";
        const name = kind === "captain" ? "You" : "Alice";
        row.innerHTML = `<img class="avatar" src="${face}" alt="" width="48" height="48" /><div class="bubble"><span class="bubble-name">${name}</span><p>${escapeHtml(text)}</p></div>`;
      }
      log.appendChild(row);
      while (log.childElementCount > LOG_MAX) log.removeChild(log.firstChild);
      log.scrollTop = log.scrollHeight;
    },

    sendAlice() {
      const text = this.aliceDraft.trim();
      if (!text || this.aliceThinking) return;
      this.aliceThinking = true;
      if (this.aliceWs && this.aliceWs.readyState === WebSocket.OPEN) {
        this.aliceWs.send(text);
      } else {
        fetch("/chat/alice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        })
          .then((r) => r.json())
          .then((j) => {
            if (j.line) this.appendAliceLine("captain", j.line.text);
            if (!j.ok) this.aliceThinking = false;
          })
          .catch(() => {
            this.aliceThinking = false;
          });
      }
      this.aliceDraft = "";
    },
  };
}

function spaceChat(agentId) {
  return {
    agentId,
    draft: "",
    thinking: false,
    ws: null,

    init() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      this.ws = new WebSocket(`${proto}//${location.host}/ws/chat/${agentId}`);
      this.ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.error) return;
          if (m.role === this.agentId || m.role === "system") this.thinking = false;
          this.append(m.role, m.text);
        } catch {
          /* ignore */
        }
      };
    },

    append(role, text) {
      const log = this.$refs.log;
      if (!log) return;
      const isCaptain = role === "captain";
      const isSystem = role === "system";
      const kind = isCaptain ? "captain" : isSystem ? "system" : "agent";
      const row = document.createElement("div");
      row.className = `bubble-row is-${isCaptain ? "captain" : isSystem ? "system" : "alice"}`;
      const name = isCaptain ? "You" : isSystem ? "System" : role;
      if (isSystem) {
        row.innerHTML = `<div class="bubble"><p>${escapeHtml(text)}</p></div>`;
      } else {
        const face = isCaptain ? "/art/captain.png" : agentAvatar(this.agentId);
        row.innerHTML = `<img class="avatar" src="${face}" alt="" width="48" height="48" /><div class="bubble"><span class="bubble-name">${escapeHtml(name)}</span><p>${escapeHtml(text)}</p></div>`;
      }
      log.appendChild(row);
      while (log.childElementCount > LOG_MAX) log.removeChild(log.firstChild);
      log.scrollTop = log.scrollHeight;
    },

    send() {
      const t = this.draft.trim();
      if (!t || this.thinking || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.thinking = true;
      this.ws.send(t);
      this.draft = "";
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
  Alpine.data("spaceChat", spaceChat);
});
