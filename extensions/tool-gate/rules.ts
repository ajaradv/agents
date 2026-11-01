/**
 * The tool gate's local rules (R4f in the vault plan fleet/plans/feature/r4-crew-isolation):
 * decided instantly, on the Mac, with nothing sent anywhere. Pure, so it can be
 * tested and shared: the extension (extensions/tool-gate.ts) runs it on every
 * tool call; anything it cannot decide goes to the node, which asks Jev.
 *
 * - allow: known-safe (fleet and crew tools, reads, routine project commands,
 *   anything a crewmate's own tools do inside its VM)
 * - stop: clear dangers (secrets, download-and-run, pushing to main or forcing,
 *   sudo, deleting outside the work, writing into secret places)
 * - ask: everything else, and free-form messages that try to steer another
 *   agent into pushing, merging, or revealing secrets
 */

export type Verdict = { decision: "allow" | "stop" | "ask"; reason: string };

export type GateContext = {
  /** The agent's working folder (repo, worktree, or vault). */
  cwd: string;
  /** The user's home folder. */
  home: string;
  /** True when this agent's built-in tools run inside a Gondolin VM. */
  inVm: boolean;
  /** Folders writes may go to besides cwd (the vault, the fleet inbox, temp). */
  writable: string[];
  /** The agent's id (FLEET_AGENT_ID); Alice's file writes are confined to her vault and her inbox folder. */
  agent?: string;
  /** Alice's vault and her own inbox folder (ALICE_VAULT, FLEET_INBOX/alice). */
  aliceFolders?: { vault: string; inbox: string };
  /** The Architect's vault (ALICE_VAULT); its writes there are limited to plans, specs, reviews and roadmaps. */
  architectVault?: string;
  /** The vault (ALICE_VAULT) for the surveyor and the `<officer>-helper` agents; they may not read career/ or profile/ in it. */
  helperVault?: string;
  /** Resolves symlinks (fs.realpathSync); without it paths are judged as written. */
  realpath?: (p: string) => string;
  /** Test seam: is this pid the live fleet node or dashboard? */
  isLiveService?: (pid: number) => boolean;
};

/** The live node and dashboard run as `bun run <fleet repo>/dashboard/(node|server).ts` (launchd/systemd); test copies run from a worktree or with a test port. */
function liveServicePid(pid: number): boolean {
  try {
    const r = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const cmd = r.stdout.toString().trim();
    return /\bbun\s+run\s+\S*\/dashboard\/(node|server)\.ts\b/.test(cmd) && !/\.treehouse\//.test(cmd);
  } catch {
    return false;
  }
}

const BUILTIN = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

/** Fleet and crew tools that only read, or act through the node's own checks (Go, orders, crew tokens). */
const SAFE_TOOLS = new Set([
  "fleet_status", "ship_log", "ship_tasks", "ship_maneuvers", "agent_chat_read", "recall", "vault_tasks", "ship_next",
  // Alice's typed reads (vault plan alice-memory-and-tools, M1); vault_patch writes only inside the vault and refuses career/ and profile/.
  "fleet_query", "vault_note", "vault_search", "vault_doctor", "vault_patch",
  // Alice's memory (M2): facts and observations in the node's journal, one line in the captain profile; the node holds them during orders.
  "fact_get", "fact_set", "remember", "log_observation",
  // Alice's answer to the proactive sweep: proposals stored in the node's journal and shown in Needs you; changes nothing else.
  "proactive_report",
  // A codemode script's own calls each pass this gate (pi runs them through the tool pipeline), so the script itself is not judged.
  "codemode",
  "voyage_status", "task_report", "task_add", "task_update", "task_claim", "run_check", "maneuver_start", "helm_propose",
  "canvas_show", "canvas_clear", "ask_captain", "notify_captain", "delegate", "ask_public", "order_step", "order_finish",
  "fleet_action", "voyage_start", "voyage_dock", "crew_change", "agent_stop", "subagent", "tool_search",
  "session_search", "memory_search", "obsidian_list_notes", "cursor_activate_skill",
  // Crew eyes: sends screenshots from allowed folders to a vision model (dashboard/lib/look.ts checks the paths).
  "look", "crew_request",
  // Helpers (dashboard/lib/helpers.ts): one job, limits in code, no tools off the hub and read-only ones on it.
  "helper",
  // An agent's own bus, through the node (dashboard/lib/bus-api.ts).
  "bus_read",
  // The captain's decision queue (dashboard/lib/decision-queue.ts): adds an item the captain orders and starts.
  "queue_add", "queue_request",
  // The flagship officers' decisions (dashboard/lib/decisions.ts): a spec to review, a design difference.
  "spec_submit", "design_review",
  // The Architect's surveyors (dashboard/lib/survey.ts): fresh reviewers on a draft; the node holds the limits and the budget.
  "survey",
  // Officers without bash (plan alice-memory-and-tools, M5): git_read runs a fixed read-only git argv in the worktree; plan_check reads a vault plan.
  "git_read", "plan_check",
]);

/** Tools whose free text reaches another agent: screened for steering. */
const MESSAGE_TOOLS = new Set(["fleet_chat", "crew_message", "bus_post", "cursor", "cursor_ask_question"]);

const STEERING = /\b(git\s+push|push\s+(to\s+)?(origin|main|master|the\s+branch)|force[- ]push|merge\s+(it|this|the|into|to)|reveal|print|show|send|paste|share)\b[^.\n]{0,60}\b(secret|token|api[ _-]?key|password|credential|\.env|ssh\s+key|private\s+key)|\b(git\s+push|force[- ]push|merge\s+into\s+(main|master)|delete\s+the\s+(branch|repo))\b/i;

/** Places that hold secrets: reading or writing them stops. */
function secretPath(p: string, home: string): string | null {
  const h = home.replace(/\/$/, "");
  const x = p.replace(/^~(?=\/|$)/, h);
  const rules: [RegExp, string][] = [
    [new RegExp(`^${esc(h)}/\\.(ssh|aws|gnupg|kube|docker)(/|$)`), "a credentials folder"],
    [new RegExp(`^${esc(h)}/\\.(netrc|npmrc|pypirc|git-credentials)$`), "a credentials file"],
    [new RegExp(`^${esc(h)}/\\.config/(op|gh|gcloud)(/|$)`), "a credentials folder"],
    [new RegExp(`^${esc(h)}/\\.pi/agent/auth\\.json$`), "pi's stored logins"],
    [new RegExp(`^${esc(h)}/Library/Keychains(/|$)`), "the keychain"],
    // macOS asks the captain to approve these ("bun would like to access data from other apps").
    [new RegExp(`^${esc(h)}/Library/(Containers(/|$)|Group( |\\\\|$))`), "another app's data"],
    [/(^|\/)\.env(\.(local|production|development|prod|dev|test))?$/, "an .env file"],
    [/(^|\/)fleet\/home\/\.env$/, "the fleet's 1Password environment"],
    [/\.(pem|p12|pfx|key)$/, "a private key file"],
    [/(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/, "a private key file"],
  ];
  for (const [re, what] of rules) if (re.test(x)) return what;
  return null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function resolve(p: string, cwd: string, home: string): string {
  const x = p.trim().replace(/^~(?=\/|$)/, home);
  if (x.startsWith("/")) return normalize(x);
  return normalize(`${cwd.replace(/\/$/, "")}/${x}`);
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

const inside = (p: string, root: string) => {
  const r = normalize(root);
  return p === r || p.startsWith(`${r}/`);
};

/** Commands that only read or run the project's own routine work. */
const ROUTINE = /^(ls|pwd|cat|head|tail|wc|sort|uniq|cut|tr|diff|file|stat|du|df|which|type|echo|printf|true|date|basename|dirname|realpath|rg|grep|egrep|fd|find|tree|jq|yq|less|sed\s+-n|awk|column|env\s*$|uname|whoami|id|ps|lsof|git\s+(status|diff|log|show|branch|rev-parse|ls-files|blame|remote\s+-v|fetch|stash\s+list|add|commit|switch|checkout|restore|worktree\s+list|config\s+--get|tag\s+-l|describe|grep)|just(\s|$)|make(\s|$)|npm\s+(test|run|ci|install|ls|view)|npx\s+-y\s+(axi-axi|tasks-axi|jev-axi|gh-axi|quota-axi|chrome-devtools-axi|lavish-axi|npm-axi|pypi-axi|sqlite-axi|@andershoffmann\/obsidian-axi)(@[\d.]+)?|pnpm\s+(test|run|install|i)|bun\s+(test|run|install|x)|bun\s+[\w./-]+\.(ts|js|mjs)\b|bunx\s+tsc|node(?=\s|$)|python3?(?=\s|$)|uv\s+(run|pip\s+list|sync|lock)|uvx\s+ruff|pytest|ruff|mypy|tsc|cargo\s+(build|check|test|clippy|fmt|run)|go\s+(build|test|vet|run)|docker\s+compose\s+(ps|logs|run|build|up|down)|tasks-axi|gh-axi|quota-axi|treehouse|herdr\s+(status|session\s+list|pane\s+list)|cdt|shot|codegraph\s+(explore|node|query|callers|callees|impact|affected|files|status)|bin\/(phone-check|vault-doctor|fleet-axi|fleet-shot|fleet-look|fleet-chart-fixture|fleet-net\s+(check|--help)|order|stamp-ship\s+--dry-run|new-agent\s+.*--dry-run|fleet-vm-image)|sleep|cd|mkdir|mktemp|touch|rm(\s+-[rfv]+)*(?=\s+[^-\s])|chmod\s+(\+x|[0-7]{3})(?=\s)|pkill\s+-f\s+["'][^"']*headless|["']?\/Applications\/(Google Chrome|Chromium)\.app\/Contents\/MacOS\/[^"']+["']?\s+--headless|cp|mv|ln\s+-s|command\s+-v|kill(\s+-(TERM|INT|15|2|9|0|KILL))?(\s+(\d+|SUBST))+(\s+[12]?>\s*\/dev\/null)?\s*$|set\s+-[euxo]|od|md5sum|shasum|xxd|base64|gzip|gunzip|tar\s+-?[tx]|unzip\s+-l|open|npx\s+(-y\s+)?playwright|curl(?=\s)(?![^|;&]*\s(-d|--data|--data-\S+|-F|--form|-T|--upload-file|-X\s*(POST|PUT|PATCH|DELETE)))|sed\s+(-[Ei]+\s+)?['"]|sed\s+-i)\b/;

const DANGER: [RegExp, string][] = [
  // A local test server (loopback) is the crew's own code, and `python3 -m json.tool` only formats: neither downloads code to run.
  [/\b(curl|wget|fetch)\b(?![^|;&]*\b(127\.0\.0\.1|localhost)\b)[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|\b(curl|wget)\b(?![^|;&]*\b(127\.0\.0\.1|localhost)\b)[^|;&]*\|\s*(python3?(?!\s+-m\s+json\.tool)|node|perl|ruby)\b|\b(ba|z)?sh\s+<\s*\(\s*(curl|wget)/, "downloads and runs code"],
  [/\bgit\s+push\b[^;&|]*(\s(-f|--force|--force-with-lease)\b|\s\+\S)/, "force-pushes"],
  [/\bgit\s+push\b[^;&|]*\b(main|master)\b/, "pushes to main"],
  [/(^|[\s;&|(])sudo\b/, "runs as root"],
  [/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\$HOME|\/Users\/?[a-z]*\/?|\.\.)(\s|$|\/\*?(\s|$))/, "deletes a home or root folder"],
  [/\b(mkfs|diskutil\s+(erase|partition)|dd\s+[^;]*of=\/dev\/)/, "erases a disk"],
  [/\b(op\s+(read|item\s+get|inject|run)|security\s+(find-generic-password|find-internet-password|dump-keychain))\b/, "reads secrets"],
  // The dashboard's and node's own APIs are for the captain's pages and fleet tools; an agent uses its tools (the fleet's first voyage docked itself with curl).
  [/\b(curl|wget|http|xh)\b[^|;&]*\b(127\.0\.0\.1|localhost|0\.0\.0\.0):(8787|8786)\/(api|v1|chat|agents|partials\/[a-z-]+\/)/, "calls the fleet's own API directly instead of a fleet tool"],
  // The op CLI looks into the 1Password app's data on start, which asks the captain; agents get keys in their environment.
  [/(^|[\s;&|(])op\s+(whoami|signin|vault|item|account|document|user|group|connect|service-account|plugin|events-api)\b/, "runs the 1Password CLI"],
  [/\bchmod\s+(-R\s+)?777\s+\//, "opens permissions on system folders"],
  // A pattern kill can take the live fleet down with a test copy (a lead ran pkill -f "bun dashboard/server.ts" on 2026-10-19): kill test servers by pid.
  [/\b(pkill|killall)\b[^;&|]*(dashboard\/(server|node)\.ts|server\.ts|node\.ts|com\.fleet|\bbun\b)/, "may stop the live fleet services (kill your own test server by its pid)"],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)\b.*\b(origin\/)?(main|master)\b/, "throws away work on main"],
];

/** Heredoc bodies are data for the command before them: keep the command line, drop the body. */
function stripHeredocs(cmd: string): { command: string; feedsInterpreter: boolean } {
  let feedsInterpreter = false;
  const command = cmd.replace(/^(.*?)<<-?\s*(['"]?)(\w+)\2([^\n]*)\n[\s\S]*?\n\s*\3\s*(?=\n|$)/gm, (_m, head: string, _q, _tag, rest: string) => {
    if (/\b(python3?|node|bun|deno|perl|ruby|php|ba|z|da)?sh?\s*(-\s*)?$|\b(python3?|node|bun|deno|perl|ruby|php)\b[^|;&]*$/.test(head.trim()) && !/\b(cat|tee)\b/.test(head)) feedsInterpreter = true;
    return `${head}${rest}`;
  });
  return { command, feedsInterpreter };
}

/** Leading words that do not change what runs: env assignments, timeout, nice, and loop or branch keywords. */
function core(segment: string): string {
  return segment
    .replace(/^(\w+=\S*\s+)+/, "")
    .replace(/^(timeout\s+\d+[smh]?|nice(\s+-n\s*\d+)?|time|nohup)\s+/, "")
    .replace(/^(do|then|else|elif)\s+/, "")
    .trim();
}

/** Split on && || ; | and newlines, but not inside quotes (grep 'a\|b' is one command). */
export function splitCommands(c: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < c.length; i++) {
    const ch = c[i]!;
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"') cur += c[++i] ?? "";
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "\\") {
      cur += ch + (c[++i] ?? "");
      continue;
    }
    const two = c.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const STRUCTURAL = /^(#.*|\w+=("[^"]*"|'[^']*'|\S*)|for\s+\w+\s+in\b.*|while\b.*|until\b.*|if\b.*|done|fi|esac|case\b.*|\{|\}|\(|\)|[a-z_]+\(\)\s*\{?)$/;

function bashVerdict(cmd: string, ctx: GateContext): Verdict {
  const stripped = stripHeredocs(cmd);
  if (stripped.feedsInterpreter) return { decision: "ask", reason: "the command runs inline code" };
  let c = stripped.command.trim();
  if (!c) return { decision: "allow", reason: "empty command" };
  for (const [re, why] of DANGER) if (re.test(c)) return { decision: "stop", reason: `the command ${why}` };
  // Secret paths named anywhere in the command.
  for (const word of c.split(/[\s'"=<>|;&()]+/)) {
    if (!word || !/[/.~]/.test(word)) continue;
    const what = secretPath(resolve(word, ctx.cwd, ctx.home), ctx.home);
    if (what && !/\.env\.example$/.test(word)) return { decision: "stop", reason: `the command touches ${what} (${word})` };
  }
  // A substitution of routine commands is routine ($(date), $(git rev-parse HEAD)); anything else hides what runs.
  for (let i = 0; i < 4 && /\$\(([^()]*)\)/.test(c); i++) {
    let hidden = false;
    c = c.replace(/\$\(([^()]*)\)/g, (_m, inner: string) => {
      if (bashVerdict(inner, ctx).decision !== "allow") hidden = true;
      return "SUBST";
    });
    if (hidden) return { decision: "ask", reason: "the command builds or loads code at run time" };
  }
  if (/\$\(|`|\beval\b|\bsource\b|(^|\s)\.\s+\//.test(c)) return { decision: "ask", reason: "the command builds or loads code at run time" };
  // Inline code (python -c, node -e, sh -c, a heredoc into an interpreter) can do anything: let Jev read it.
  if (/\b(python3?|node|bun|deno|perl|ruby|php)\s+(-[a-zA-Z]*\s+)*-(c|e|-eval)\b|\b(ba|z|da)?sh\s+-c\b|\b(python3?|node|bun|perl|ruby|ba|z)?sh?\s*<<|\b(python3?|node|bun|perl|ruby)\s*<</.test(c)) {
    return { decision: "ask", reason: "the command runs inline code" };
  }
  const segments = splitCommands(c).map(core).filter(Boolean);
  // kill by pid is routine for a crewmate's own test servers, never for the live fleet's node or dashboard.
  for (const seg of segments) {
    if (!/^kill\b/.test(seg)) continue;
    for (const pid of seg.match(/\b\d{2,7}\b/g) ?? []) if ((ctx.isLiveService ?? liveServicePid)(Number(pid))) return { decision: "stop", reason: `the command stops the live fleet service (pid ${pid})` };
  }
  const skillScript = (seg: string) => /^(~|\/Users\/[^/]+)\/\.(agents|pi\/agent)\/skills\/[\w.-]+\/scripts\//.test(seg);
  const unknown = segments.find((s) => !STRUCTURAL.test(s) && !ROUTINE.test(s) && !skillScript(s));
  if (unknown) return { decision: "ask", reason: `not a routine command: ${unknown.slice(0, 80)}` };
  // rm, mv, cp, and redirects that land outside the work are worth a look.
  const targets = [...c.matchAll(/>>?\s*([^\s;&|]+)/g)].map((m) => m[1]!);
  for (const seg of segments) {
    const words = seg.split(/\s+/);
    if (["rm", "mv", "cp", "touch", "mkdir", "ln", "chmod"].includes(words[0]!)) targets.push(...words.slice(1).filter((w) => w && !w.startsWith("-")));
    if (words[0] === "sed" && words.some((w) => /^-[a-zA-Z]*i/.test(w))) targets.push(...words.slice(1).filter((w) => w && !w.startsWith("-") && !/^['"]/.test(w)).slice(1));
  }
  const outside = targets.find((t) => !/^\/dev\/null$/.test(t) && !writableAt(resolve(t, ctx.cwd, ctx.home), ctx));
  if (outside) return { decision: "ask", reason: `writes outside the agent's folders: ${outside}` };
  return { decision: "allow", reason: "routine command" };
}

function writableAt(p: string, ctx: GateContext): boolean {
  return inside(p, ctx.cwd) || ctx.writable.some((w) => inside(p, w));
}

/** The path with symlinks resolved as far as it exists (a new file under a linked folder resolves through the folder). */
function real(p: string, ctx: GateContext): string {
  if (!ctx.realpath) return p;
  let rest = "";
  for (let cur = p; cur !== "/"; cur = cur.slice(0, cur.lastIndexOf("/")) || "/") {
    try {
      return normalize(`${ctx.realpath(cur)}${rest}`);
    } catch {
      rest = `${cur.slice(cur.lastIndexOf("/"))}${rest}`;
    }
  }
  return p;
}

/**
 * Alice writes only in her vault and her inbox folder (vault plan alice-memory-and-tools, M3). Inside the
 * vault the git and Obsidian folders are off limits and career/ and profile/ wait for the captain, as her role says.
 */
function aliceWrite(tool: string, raw: string, p: string, ctx: GateContext): Verdict | null {
  const f = ctx.aliceFolders;
  if (!f) return null;
  const roots = [f.vault, f.inbox].map((r) => [normalize(r), real(normalize(r), ctx)] as const);
  const target = real(p, ctx);
  const where = roots.findIndex(([lexical, resolved]) => inside(p, lexical) && inside(target, resolved));
  if (where < 0) return { decision: "stop", reason: `Alice may write only in her vault (${f.vault}) and her inbox folder (${f.inbox}); ${tool} of ${raw} is outside them` };
  if (where === 0) {
    const first = target.slice(roots[0]![1].length).split("/").filter(Boolean)[0] ?? "";
    if (first === ".git" || first === ".obsidian") return { decision: "stop", reason: `${tool} inside the vault's ${first} folder (${raw})` };
    if (first === "career" || first === "profile") return { decision: "ask", reason: `${tool} in the vault's ${first}/ folder: the captain approves first (${raw})` };
  }
  return null;
}

/**
 * The Architect writes plans, specs, reviews and roadmaps in the vault; the git and Obsidian folders and the
 * captain's career/ and profile/ stop, and any other note waits for the captain. Outside the vault: no opinion.
 */
function architectWrite(tool: string, raw: string, p: string, ctx: GateContext): Verdict | null {
  if (!ctx.architectVault) return null;
  const lexical = normalize(ctx.architectVault);
  const resolved = real(lexical, ctx);
  const target = real(p, ctx);
  if (!inside(p, lexical) && !inside(target, resolved)) return null;
  if (!inside(target, resolved)) return { decision: "stop", reason: `${tool} of ${raw} leaves the vault through a link` };
  const rel = target.slice(resolved.length).replace(/^\//, "");
  const first = rel.split("/")[0] ?? "";
  if (first === ".git" || first === ".obsidian" || first === "career" || first === "profile") return { decision: "stop", reason: `${tool} inside the vault's ${first} folder (${raw})` };
  if (/^fleet\/(plans|specs|reviews)\/./.test(rel) || /^ships\/[^/]+\/roadmap\.md$/.test(rel)) return { decision: "allow", reason: "the Architect's plans, specs, reviews and roadmaps" };
  return { decision: "ask", reason: `${tool} of ${raw}: the Architect writes plans, specs, reviews and roadmaps in the vault; other vault notes need the captain` };
}

/** Helpers and surveyors read the vault but never the captain's career/ and profile/ folders (prompts alone were all that stopped them). */
function helperRead(tool: string, raw: string, p: string, ctx: GateContext): Verdict | null {
  if (!ctx.helperVault) return null;
  const lexical = normalize(ctx.helperVault);
  const resolved = real(lexical, ctx);
  const target = real(p, ctx);
  for (const first of ["career", "profile"]) {
    if (inside(p, `${lexical}/${first}`) || inside(target, `${resolved}/${first}`)) return { decision: "stop", reason: `${tool} inside the vault's ${first} folder (${raw}); helpers never read it` };
  }
  // A search from the vault root (or above it) would walk career/ and profile/ too: search a folder in it instead.
  if ((tool === "grep" || tool === "find") && (inside(lexical, p) || inside(resolved, target))) {
    return { decision: "stop", reason: `${tool} from ${raw} would search the vault's career/ and profile/ folders; search a folder inside the vault (for example fleet/) instead` };
  }
  return null;
}

/** Decide a tool call locally, or say it needs a closer look. */
export function localVerdict(tool: string, input: Record<string, unknown>, ctx: GateContext): Verdict {
  if (BUILTIN.has(tool)) {
    // A crewmate's own tools run in its VM: the Mac's files and keys are not there.
    if (ctx.inVm) return { decision: "allow", reason: "runs inside the crew VM" };
    if (tool === "bash") return bashVerdict(String(input.command ?? ""), ctx);
    const raw = String(input.path ?? input.file_path ?? ".");
    const p = resolve(raw, ctx.cwd, ctx.home);
    const what = secretPath(p, ctx.home);
    if (what) return { decision: "stop", reason: `${tool} of ${what} (${raw})` };
    if (tool !== "write" && tool !== "edit" && ctx.helperVault) {
      const v = helperRead(tool, raw, p, ctx);
      if (v) return v;
    }
    if ((tool === "write" || tool === "edit") && ctx.agent === "alice") {
      const v = aliceWrite(tool, raw, p, ctx);
      if (v) return v;
    }
    if ((tool === "write" || tool === "edit") && ctx.agent === "architect") {
      const v = architectWrite(tool, raw, p, ctx);
      if (v) return v;
    }
    if (tool === "write" || tool === "edit") {
      return writableAt(p, ctx) ? { decision: "allow", reason: "write inside the agent's folders" } : { decision: "ask", reason: `${tool} outside the agent's folders: ${raw}` };
    }
    return { decision: "allow", reason: "read" };
  }
  if (MESSAGE_TOOLS.has(tool)) {
    const text = String(input.text ?? input.message ?? input.prompt ?? input.question ?? input.summary ?? "");
    return STEERING.test(text) ? { decision: "ask", reason: "the message asks another agent to push, merge, or reveal something" } : { decision: "allow", reason: "message" };
  }
  if (SAFE_TOOLS.has(tool)) return { decision: "allow", reason: "fleet tool" };
  return { decision: "ask", reason: `unfamiliar tool ${tool}` };
}

// ---------------------------------------------------------------- result screen

/** Commands whose output comes from outside the Mac: what a planted instruction would ride in on. */
const FETCHES = /\b(curl|wget|gh\s+(issue|pr|api|repo\s+view|release\s+view)|npm\s+(view|pack|info|show)|pip3?\s+(download|show)|git\s+(clone|pull|fetch\s+.*&&.*(show|log))|lynx|w3m|httpie|http\s+(get|GET))\b/;
/** Places that hold other people's text. */
const OUTSIDE_PATHS = /(^|\/)(node_modules|vendor|third_party|site-packages|\.cache|Downloads)\/|^\/(tmp|private\/tmp)\//;
/** Phrases aimed at a model rather than a reader. */
const INJECTION_MARKERS = /ignore (all |any )?(previous|prior|above) (instructions|directions)|disregard (the|your|all) (previous|prior|system)|you are now (a|an|in)\b|system prompt|<\|im_start\|>|\[INST\]|BEGIN (SYSTEM|ADMIN) (PROMPT|INSTRUCTIONS)|do not (tell|inform|mention (this|it) to) the user|new instructions:/i;

/**
 * Why a tool result should be screened for instructions aimed at the agent
 * (null: it need not be). Cheap and local; the node asks Jev only for these.
 */
/** The fleet's own instructions (roles, agent configs, skills, CLAUDE.md, AGENTS.md): written for models on purpose. */
const OWN_INSTRUCTIONS = /(^|[\s/"'])(roles\/[\w-]+\.md|agents\/[\w-]+\/[\w.-]+|skills\/[\w./-]+\/SKILL\.md|CLAUDE\.md|AGENTS\.md)(?=$|[\s"'])/;
/** A plain local read in bash: cat/head/tail/sed -n/grep/wc of files, nothing fetched or run. */
const PLAIN_READ = /^(cd\s+\S+\s*&&\s*)?(cat|head|tail|sed\s+-n|grep|rg|wc|less)\b[^|;&`$()]*$/;

function readsOwnInstructions(tool: string, input: Record<string, unknown>): boolean {
  if (tool === "read") return OWN_INSTRUCTIONS.test(String(input.path ?? input.file_path ?? ""));
  if (tool !== "bash") return false;
  const cmd = String(input.command ?? "").trim();
  return PLAIN_READ.test(cmd.replace(/\s+2>\/dev\/null/g, "")) && OWN_INSTRUCTIONS.test(cmd) && !FETCHES.test(cmd);
}

export function screenReason(tool: string, input: Record<string, unknown>, text: string): string | null {
  if (!text || text.length < 40) return null;
  // Role files and skills are instructions for agents by design: flagging them only adds noise (seen on the first fleet voyage).
  if (INJECTION_MARKERS.test(text)) return readsOwnInstructions(tool, input) ? null : "the text contains phrases aimed at a model";
  if (tool === "bash" && FETCHES.test(String(input.command ?? ""))) return "the output came from the network";
  if ((tool === "read" || tool === "grep") && OUTSIDE_PATHS.test(String(input.path ?? input.file_path ?? ""))) return "the file holds third-party text";
  return null;
}
