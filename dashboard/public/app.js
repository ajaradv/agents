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
          const opts = (q.options || [])
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
