import { spawn } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { ROOT } from "./paths.ts";

/**
 * Helpers on any host (H2b, vault remote-ship-hosts): a short-lived pi with a
 * narrow role, started for one job on the host that suits it, gone when it
 * reports. The hub's side is crewHelper (lib/crew-api.ts); the laptop's is
 * /host/helper (worker.ts). Both run a helper with runHelperHere.
 *
 * - A definition is a file in agents/helpers/ (the sub-agent format) with `helper: true`
 *   and its limits: `hosts`, `input`, `budget_usd`, `timeout_secs`.
 * - Where it runs is a rule in code (pickHelperHost), never a model: a check
 *   helper where the voyage's repo is; else the laptop while it is up, if the
 *   definition allows it; else the hub.
 * - Off the hub a helper gets no tools at all: its inputs (screenshots, a check's
 *   output) are attached by code, so a helper on the laptop can read or run nothing there.
 * - Slots per host (the hub 1, the laptop 3), and the budget and time limit, stop it in code.
 */

export type HelperHost = "local" | "laptop";
export type HelperInput = "task" | "shots" | "check";

export type HelperDef = {
  name: string;
  description: string;
  model: string;
  tools: string[];
  input: HelperInput;
  hosts: HelperHost[];
  budgetUsd: number;
  timeoutSecs: number;
  prompt: string;
};

export type HelperResult = { ok: boolean; text: string; cost: number; ms: number; model: string; stopped?: "time" | "budget" | "error" };

export const helpersDir = () => process.env.FLEET_HELPERS_DIR ?? join(ROOT, "agents", "helpers");
export const HOST_SLOTS: Record<HelperHost, number> = { local: 1, laptop: 3 };
export const HOST_LABEL: Record<HelperHost, string> = { local: "the hub", laptop: "the laptop" };

const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((x) => String(x).trim()).filter(Boolean);

/** One definition file, or null when it is not a helper. */
export function parseHelper(name: string, text: string): HelperDef | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = (parse(m[1]!) ?? {}) as Record<string, unknown>;
  if (fm.helper !== true) return null;
  const input = String(fm.input ?? "task");
  const hosts = list(fm.hosts).filter((h): h is HelperHost => h === "local" || h === "laptop");
  return {
    name: String(fm.name ?? name),
    description: String(fm.description ?? ""),
    model: String(fm.model ?? ""),
    tools: list(fm.tools),
    input: input === "shots" || input === "check" ? input : "task",
    hosts: hosts.length ? hosts : ["local"],
    budgetUsd: Math.min(5, Math.max(0.01, Number(fm.budget_usd) || 0.25)),
    timeoutSecs: Math.min(1800, Math.max(30, Number(fm.timeout_secs) || 300)),
    prompt: m[2]!.trim(),
  };
}

export async function helperDefs(dir = helpersDir()): Promise<HelperDef[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".md")).sort();
  const defs = await Promise.all(files.map(async (f) => parseHelper(f.replace(/\.md$/, ""), await readFile(join(dir, f), "utf8"))));
  return defs.filter((d): d is HelperDef => d !== null);
}

/** Where a helper runs: the rule in code. `requested` is auto, hub, or laptop. */
export function pickHelperHost(def: HelperDef, requested: string, ctx: { laptopUp: boolean; voyageHost: HelperHost }): { host: HelperHost } | { error: string } {
  const want = requested === "hub" || requested === "local" ? "local" : requested === "laptop" ? "laptop" : "auto";
  let host: HelperHost;
  if (def.input === "check") {
    // A check runs in the voyage's repo, so its helper goes where the repo is.
    if (want !== "auto" && want !== ctx.voyageHost) return { error: `${def.name} runs where the voyage's repo is (${HOST_LABEL[ctx.voyageHost]}).` };
    host = ctx.voyageHost;
  } else if (want === "auto") {
    host = def.hosts.includes("laptop") && ctx.laptopUp ? "laptop" : "local";
  } else {
    host = want;
  }
  if (host === "laptop" && !ctx.laptopUp) return { error: "The laptop is not up (asleep, or its worker is not running). Use host auto or hub." };
  if (!def.hosts.includes(host)) return { error: `${def.name} does not run on ${HOST_LABEL[host]} (hosts: ${def.hosts.map((h) => HOST_LABEL[h]).join(", ")}).` };
  return { host };
}

const busy: Record<HelperHost, number> = { local: 0, laptop: 0 };

/** Take one of a host's helper slots; false when they are all in use. */
export function takeSlot(host: HelperHost): boolean {
  if (busy[host] >= HOST_SLOTS[host]) return false;
  busy[host]++;
  return true;
}

export function freeSlot(host: HelperHost): void {
  busy[host] = Math.max(0, busy[host] - 1);
}

/** The pi command line: nothing loaded but the definition, and no tools at all off the hub. */
export function helperArgs(def: HelperDef, task: string, files: string[], host: HelperHost): string[] {
  const args = ["--mode", "json", "-p", "--no-session", "--no-skills", "--no-extensions", "--no-prompt-templates", "--no-mcp", "--no-context-files"];
  if (def.model) args.push("--model", def.model);
  if (host === "local" && def.tools.length) args.push("--tools", def.tools.join(","));
  else args.push("--no-tools");
  if (def.prompt) args.push("--append-system-prompt", def.prompt);
  for (const f of files) args.push(`@${f}`);
  args.push(`Task: ${task}`);
  return args;
}

type Usage = { cost?: { total?: number } };
type Event = { type?: string; message?: { role?: string; model?: string; usage?: Usage; content?: { type: string; text?: string }[]; errorMessage?: string } };

/** Run a helper on this machine: one task, its last answer back, stopped at its time or budget limit. */
export function runHelperHere(def: HelperDef, task: string, o: { cwd: string; files: string[]; host: HelperHost; env: Record<string, string | undefined>; bin?: string }): Promise<HelperResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const proc = spawn(o.bin ?? process.env.FLEET_PI_BIN ?? "pi", helperArgs(def, task, o.files, o.host), { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let cost = 0;
    let answer = "";
    let model = def.model;
    let error = "";
    let stopped: HelperResult["stopped"];
    let buf = "";
    let stderr = "";
    // The whole group: a hub helper's bash tool may have started children.
    const kill = (why: "time" | "budget") => {
      stopped ??= why;
      try {
        process.kill(-proc.pid!, "SIGTERM");
      } catch {
        proc.kill("SIGTERM");
      }
      setTimeout(() => {
        try {
          process.kill(-proc.pid!, "SIGKILL");
        } catch {
          /* gone */
        }
      }, 5000).unref();
    };
    const timer = setTimeout(() => kill("time"), def.timeoutSecs * 1000);
    const line = (raw: string) => {
      let e: Event;
      try {
        e = JSON.parse(raw) as Event;
      } catch {
        return;
      }
      const msg = e.message;
      if (e.type !== "message_end" || msg?.role !== "assistant") return;
      cost += msg.usage?.cost?.total ?? 0;
      if (msg.model) model = msg.model;
      const said = (msg.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
      if (said) answer = said;
      if (msg.errorMessage) error = msg.errorMessage;
      if (cost > def.budgetUsd) kill("budget");
    };
    proc.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) line(l);
    });
    proc.stderr!.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    const done = (code: number | null) => {
      clearTimeout(timer);
      if (buf.trim()) line(buf);
      const ms = Date.now() - started;
      cost = Math.round(cost * 10_000) / 10_000;
      if (stopped === "time") return resolve({ ok: false, text: `${def.name} ran out of time (${def.timeoutSecs}s).${answer ? ` Last answer: ${answer}` : ""}`, cost, ms, model, stopped });
      if (stopped === "budget") return resolve({ ok: false, text: `${def.name} reached its budget ($${def.budgetUsd}).${answer ? ` Last answer: ${answer}` : ""}`, cost, ms, model, stopped });
      if (code !== 0 || !answer) return resolve({ ok: false, text: `${def.name} failed: ${error || stderr.trim().split("\n").pop() || `exit ${code}`}`, cost, ms, model, stopped: "error" });
      resolve({ ok: true, text: answer, cost, ms, model });
    };
    proc.on("close", done);
    proc.on("error", (e) => {
      error = e.message;
      done(127);
    });
  });
}

export type ShotOptions = { url: string; width: number; height: number; mobile: boolean; wait: number };

/** Desktop and phone screenshots of up to two pages, written to `dir`; the paths, in order. */
export async function takeShots(urls: string[], dir: string, shoot: (o: ShotOptions) => Promise<Uint8Array>): Promise<string[]> {
  const files: string[] = [];
  for (const [i, url] of urls.slice(0, 2).entries()) {
    for (const v of [{ name: "desktop", width: 1440, mobile: false }, { name: "phone", width: 390, mobile: true }]) {
      const path = join(dir, `page${i + 1}-${v.name}.png`);
      await writeFile(path, await shoot({ url, width: v.width, height: 1000, mobile: v.mobile, wait: 1500 }));
      files.push(path);
    }
  }
  return files;
}

/** The pages a screenshot helper may open: http(s) only, at most two. */
export function shotUrls(v: unknown): string[] | string {
  const urls = (Array.isArray(v) ? v : []).map(String).filter(Boolean);
  if (!urls.length) return "Give the page to check in urls (one or two http(s) URLs).";
  if (urls.length > 2) return "At most two pages per check.";
  const bad = urls.find((u) => !/^https?:\/\/[^\s]+$/.test(u));
  return bad ? `Not an http(s) URL: ${bad}` : urls;
}
