/**
 * Fleet Gondolin: a crewmate's built-in tools (read, write, edit, bash, grep,
 * find, ls, and ! commands) run inside a local Linux micro-VM (R4 in the vault
 * plan fleet/plans/feature/r4-crew-isolation). Vendored from pi-coding-agent
 * 1.2.0 examples/extensions/gondolin (MIT), with fleet changes:
 *
 * - Only the ship's repo or the voyage's worktree (/workspace), the
 *   crewmate's memory folder (/memory), the ship's shared memory
 *   (/ship-memory: project and voyage memory), the crewmate's cache
 *   (/cache: pre-commit hook environments, built for the guest, never the
 *   Mac's), and, in a worktree, the repo's .git
 *   (at its own path, which the worktree's .git file points to) are mounted;
 *   the rest of the Mac does not exist in the guest.
 * - Commands get a fixed environment (home, locale, CI, git identity), never
 *   the host's: no provider keys, no FLEET_* tokens. (The example passed the
 *   host environment through.)
 * - Network: only the ship's allowlist (FLEET_VM_ALLOW), HTTP/HTTPS only;
 *   blocked hosts are reported to the node (tool failure log, ship log).
 * - The VM boots on the first tool call, not at session start, and uses the
 *   fleet image (FLEET_VM_IMAGE, built by bin/fleet-vm-image).
 * - The agent's skill folders (FLEET_VM_RO_MOUNTS) are mounted read-only at
 *   their host paths: pi lists skills by host path, and the model reads them.
 * - Agents with `vm_image: browser` get the browser image (R4e: Chromium,
 *   fonts, and the `shot` command) and 2 GB (FLEET_VM_BROWSER, FLEET_VM_RAM).
 * - No fallback: when the VM cannot start, tools fail and say so; they never
 *   run on the host instead.
 *
 * bin/launch loads this (extensions/gondolin.ts) for crewmates of ships with
 * `isolation: vm`. Needs QEMU (brew install qemu).
 */

import path from "node:path";
import { createHttpHooks, ReadonlyProvider, RealFSProvider, VM } from "@earendil-works/gondolin";
import { allowedHosts, browserNote, GUEST_CACHE, guestEnv, hostAllowed, readonlyMounts, vmSize } from "./policy.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	DEFAULT_MAX_BYTES,
	type EditOperations,
	type FindOperations,
	formatSize,
	type GrepToolDetails,
	type GrepToolInput,
	type LsOperations,
	type ReadOperations,
	truncateHead,
	truncateLine,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

const GUEST_WORKSPACE = "/workspace";
const GUEST_MEMORY = "/memory";
/** The crewmate's memory folder on the host (fleet/inbox/<id>/memory), mounted at /memory. */
const HOST_MEMORY = process.env.FLEET_VM_MEMORY ?? "";
const GUEST_SHIP_MEMORY = "/ship-memory";
/** The ship's shared memory folder on the host (fleet/inbox/ships/<ship>/memory: project and voyage memory). */
const HOST_SHIP_MEMORY = process.env.FLEET_VM_SHIP_MEMORY ?? "";
/** The crewmate's cache folder on the host (fleet/inbox/<id>/cache), mounted at /cache: pre-commit hook environments. */
const HOST_CACHE = process.env.FLEET_VM_CACHE ?? "";
const DEFAULT_GREP_LIMIT = 100;

type TextToolResult<TDetails> = {
	content: Array<{ type: "text"; text: string }>;
	details: TDetails | undefined;
};

function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function toPosix(value: string): string {
	return value.split(path.sep).join(path.posix.sep);
}

function isInsideHostPath(root: string, value: string): boolean {
	const relativePath = path.relative(root, value);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function hostPathToGuest(localCwd: string, hostPath: string): string {
	const relativePath = path.relative(localCwd, hostPath);
	if (!isInsideHostPath(localCwd, hostPath)) return toPosix(hostPath);
	return relativePath ? path.posix.join(GUEST_WORKSPACE, toPosix(relativePath)) : GUEST_WORKSPACE;
}

export function toGuestPath(localCwd: string, inputPath: string): string {
	const trimmed = stripAtPrefix(inputPath.trim());
	if (!trimmed) return GUEST_WORKSPACE;
	if (path.isAbsolute(trimmed)) {
		if (isInsideHostPath(localCwd, trimmed)) return hostPathToGuest(localCwd, trimmed);
		if (HOST_MEMORY && isInsideHostPath(HOST_MEMORY, trimmed)) {
			const rel = path.relative(HOST_MEMORY, trimmed);
			return rel ? path.posix.join(GUEST_MEMORY, toPosix(rel)) : GUEST_MEMORY;
		}
		if (HOST_SHIP_MEMORY && isInsideHostPath(HOST_SHIP_MEMORY, trimmed)) {
			const rel = path.relative(HOST_SHIP_MEMORY, trimmed);
			return rel ? path.posix.join(GUEST_SHIP_MEMORY, toPosix(rel)) : GUEST_SHIP_MEMORY;
		}
		return path.posix.resolve("/", toPosix(trimmed));
	}
	return path.posix.resolve(GUEST_WORKSPACE, toPosix(trimmed));
}

function createGondolinReadOps(vm: VM, localCwd: string): ReadOperations {
	return {
		readFile: async (filePath) => vm.fs.readFile(toGuestPath(localCwd, filePath)),
		access: async (filePath) => {
			await vm.fs.access(toGuestPath(localCwd, filePath));
		},
		detectImageMimeType: async (filePath) => {
			const ext = path.posix.extname(toGuestPath(localCwd, filePath)).toLowerCase();
			if (ext === ".png") return "image/png";
			if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
			if (ext === ".gif") return "image/gif";
			if (ext === ".webp") return "image/webp";
			return null;
		},
	};
}

function createGondolinWriteOps(vm: VM, localCwd: string): WriteOperations {
	return {
		writeFile: async (filePath, content) => {
			await vm.fs.writeFile(toGuestPath(localCwd, filePath), content, { encoding: "utf8" });
		},
		mkdir: async (dirPath) => {
			await vm.fs.mkdir(toGuestPath(localCwd, dirPath), { recursive: true });
		},
	};
}

function createGondolinEditOps(vm: VM, localCwd: string): EditOperations {
	const readOps = createGondolinReadOps(vm, localCwd);
	const writeOps = createGondolinWriteOps(vm, localCwd);
	return {
		readFile: readOps.readFile,
		writeFile: writeOps.writeFile,
		access: readOps.access,
	};
}

function createGondolinLsOps(vm: VM, localCwd: string): LsOperations {
	return {
		exists: async (filePath) => {
			try {
				await vm.fs.access(toGuestPath(localCwd, filePath));
				return true;
			} catch {
				return false;
			}
		},
		stat: async (filePath) => vm.fs.stat(toGuestPath(localCwd, filePath)),
		readdir: async (dirPath) => vm.fs.listDir(toGuestPath(localCwd, dirPath)),
	};
}

async function walkGuestFiles(
	vm: VM,
	root: string,
	visit: (guestPath: string, relativePath: string) => Promise<boolean>,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) throw new Error("Operation aborted");
	const stat = await vm.fs.stat(root, { signal });
	if (!stat.isDirectory()) return visit(root, path.posix.basename(root));

	const walkDirectory = async (dir: string, relativeDir: string): Promise<boolean> => {
		if (signal?.aborted) throw new Error("Operation aborted");
		const entries = await vm.fs.listDir(dir, { signal });
		for (const entry of entries) {
			if (entry === ".git" || entry === "node_modules") continue;
			const guestPath = path.posix.join(dir, entry);
			const relativePath = relativeDir ? path.posix.join(relativeDir, entry) : entry;
			let entryStat: Awaited<ReturnType<VM["fs"]["stat"]>>;
			try {
				entryStat = await vm.fs.stat(guestPath, { signal });
			} catch {
				continue;
			}
			if (entryStat.isDirectory()) {
				if (!(await walkDirectory(guestPath, relativePath))) return false;
			} else if (!(await visit(guestPath, relativePath))) {
				return false;
			}
		}
		return true;
	};

	return walkDirectory(root, "");
}

function matchesToolGlob(relativePath: string, pattern: string): boolean {
	const normalizedPattern = toPosix(pattern);
	if (normalizedPattern.includes("/")) {
		return (
			path.posix.matchesGlob(relativePath, normalizedPattern) ||
			path.posix.matchesGlob(relativePath, `**/${normalizedPattern}`)
		);
	}
	return path.posix.matchesGlob(path.posix.basename(relativePath), normalizedPattern);
}

function createGondolinFindOps(vm: VM, localCwd: string): FindOperations {
	return {
		exists: async (filePath) => {
			try {
				await vm.fs.access(toGuestPath(localCwd, filePath));
				return true;
			} catch {
				return false;
			}
		},
		glob: async (pattern, cwd, options) => {
			const root = toGuestPath(localCwd, cwd);
			const results: string[] = [];
			await walkGuestFiles(vm, root, async (guestPath, relativePath) => {
				if (results.length >= options.limit) return false;
				if (matchesToolGlob(relativePath, pattern)) results.push(guestPath);
				return results.length < options.limit;
			});
			return results;
		},
	};
}

function createLineMatcher(pattern: string, literal: boolean | undefined, ignoreCase: boolean | undefined) {
	if (literal) {
		const needle = ignoreCase ? pattern.toLowerCase() : pattern;
		return (line: string) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
	}
	const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
	return (line: string) => regex.test(line);
}

function appendGrepBlock(params: {
	outputLines: string[];
	lines: string[];
	relativePath: string;
	lineIndex: number;
	contextLines: number;
}): boolean {
	let linesTruncated = false;
	const start = params.contextLines > 0 ? Math.max(0, params.lineIndex - params.contextLines) : params.lineIndex;
	const end =
		params.contextLines > 0
			? Math.min(params.lines.length - 1, params.lineIndex + params.contextLines)
			: params.lineIndex;

	for (let index = start; index <= end; index++) {
		const rawLine = params.lines[index] ?? "";
		const { text, wasTruncated } = truncateLine(rawLine.replace(/\r/g, ""));
		if (wasTruncated) linesTruncated = true;
		const separator = index === params.lineIndex ? ":" : "-";
		params.outputLines.push(`${params.relativePath}${separator}${index + 1}${separator} ${text}`);
	}
	return linesTruncated;
}

async function executeGondolinGrep(
	vm: VM,
	localCwd: string,
	params: GrepToolInput,
	signal?: AbortSignal,
): Promise<TextToolResult<GrepToolDetails>> {
	const root = toGuestPath(localCwd, params.path ?? ".");
	const rootStat = await vm.fs.stat(root, { signal });
	const rootIsDirectory = rootStat.isDirectory();
	const matcher = createLineMatcher(params.pattern, params.literal, params.ignoreCase);
	const contextLines = params.context && params.context > 0 ? params.context : 0;
	const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
	const outputLines: string[] = [];
	const details: GrepToolDetails = {};
	let matchCount = 0;
	let matchLimitReached = false;
	let linesTruncated = false;

	await walkGuestFiles(
		vm,
		root,
		async (guestPath, relativePath) => {
			if (matchCount >= effectiveLimit) return false;
			if (params.glob && !matchesToolGlob(relativePath, params.glob)) return true;
			let content: string;
			try {
				content = await vm.fs.readFile(guestPath, { encoding: "utf8", signal });
			} catch {
				return true;
			}
			const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			const displayPath = rootIsDirectory ? relativePath : path.posix.basename(guestPath);
			for (let index = 0; index < lines.length; index++) {
				if (signal?.aborted) throw new Error("Operation aborted");
				if (!matcher(lines[index] ?? "")) continue;
				matchCount++;
				if (appendGrepBlock({ outputLines, lines, relativePath: displayPath, lineIndex: index, contextLines })) {
					linesTruncated = true;
				}
				if (matchCount >= effectiveLimit) {
					matchLimitReached = true;
					return false;
				}
			}
			return true;
		},
		signal,
	);

	if (matchCount === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

	const rawOutput = outputLines.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	const notices: string[] = [];
	let output = truncation.content;

	if (matchLimitReached) {
		details.matchLimitReached = effectiveLimit;
		notices.push(`${effectiveLimit} matches limit reached`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push("long lines truncated");
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

	return {
		content: [{ type: "text", text: output }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

/** Tell the node about a VM event (crew API); best effort, never blocks a tool. */
function reportVm(event: "start" | "stop" | "blocked" | "error", detail: string): void {
	const ship = process.env.FLEET_SHIP ?? "";
	const base = (process.env.FLEET_DASHBOARD_URL ?? "").replace(/\/$/, "");
	if (!ship || !base) return;
	void fetch(`${base}/api/crew/${encodeURIComponent(ship)}/vm`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-fleet-crew-token": process.env.FLEET_CREW_TOKEN ?? "" },
		body: JSON.stringify({ event, detail: detail.slice(0, 300) }),
		signal: AbortSignal.timeout(5000),
	}).catch(() => {});
}

function createGondolinBashOps(vm: VM, localCwd: string, shellPath: string): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			if (signal?.aborted) throw new Error("aborted");
			const guestCwd = toGuestPath(localCwd, cwd);
			const controller = new AbortController();
			const onAbort = () => controller.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			let timedOut = false;
			const timer =
				timeout && timeout > 0
					? setTimeout(() => {
							timedOut = true;
							controller.abort();
						}, timeout * 1000)
					: undefined;

			try {
				const proc = vm.exec([shellPath, "-lc", command], {
					cwd: guestCwd,
					env: guestEnv(),
					signal: controller.signal,
					stdout: "pipe",
					stderr: "pipe",
				});
				for await (const chunk of proc.output()) onData(chunk.data);
				const result = await proc;
				return { exitCode: result.exitCode };
			} catch (error) {
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				throw error;
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}

export default function (pi: ExtensionAPI) {
	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);
	const localGrep = createGrepTool(localCwd);
	const localFind = createFindTool(localCwd);
	const localLs = createLsTool(localCwd);

	let vm: VM | undefined;
	let vmStarting: Promise<VM> | undefined;
	let shellPath = "/bin/sh";

	async function startVm(ctx?: ExtensionContext): Promise<VM> {
		ctx?.ui.setStatus("gondolin", ctx.ui.theme.fg("accent", `Gondolin: starting ${GUEST_WORKSPACE}`));
		if (process.env.FLEET_VM_IMAGE) process.env.GONDOLIN_GUEST_DIR = process.env.FLEET_VM_IMAGE;
		const allow = allowedHosts();
		const { httpHooks, env } = createHttpHooks({
			allowedHosts: allow.length ? allow : ["no-network.invalid"],
			isRequestAllowed: (req: Request) => {
				let host = req.headers.get("host") ?? "";
				try {
					host ||= new URL(req.url).host;
				} catch {
					/* no url */
				}
				const ok = hostAllowed(host, allow);
				if (!ok) reportVm("blocked", host || "unknown host");
				return ok;
			},
		});
		const mounts: Record<string, RealFSProvider | ReadonlyProvider> = { [GUEST_WORKSPACE]: new RealFSProvider(localCwd) };
		if (HOST_MEMORY) mounts[GUEST_MEMORY] = new RealFSProvider(HOST_MEMORY);
		if (HOST_SHIP_MEMORY) mounts[GUEST_SHIP_MEMORY] = new RealFSProvider(HOST_SHIP_MEMORY);
		if (HOST_CACHE) mounts[GUEST_CACHE] = new RealFSProvider(HOST_CACHE);
		// In a voyage worktree, .git is a file pointing into the repo's .git: mount it at its own path so git works.
		const gitDir = process.env.FLEET_VM_GITDIR ?? "";
		if (gitDir && path.isAbsolute(gitDir)) mounts[gitDir] = new RealFSProvider(gitDir);
		// The skills pi lists for this agent, read-only at their host paths, so the model can follow them.
		for (const dir of readonlyMounts()) if (!mounts[dir]) mounts[dir] = new ReadonlyProvider(new RealFSProvider(dir));
		let created: VM;
		try {
			created = await VM.create({ sessionLabel: `fleet ${process.env.FLEET_AGENT_ID ?? path.basename(localCwd)}`, httpHooks, env, vfs: { mounts }, ...vmSize() });
			const bashProbe = await created.exec(["/bin/sh", "-lc", "command -v bash || true; git config --global --add safe.directory '*' 2>/dev/null || true"]);
			shellPath = bashProbe.stdout.trim().split("\n")[0] || "/bin/sh";
		} catch (e) {
			const why = e instanceof Error ? e.message : String(e);
			reportVm("error", why);
			throw new Error(`Isolation is unavailable: the crew VM did not start (${why.slice(0, 200)}). Tools do not run on the host instead. Tell the captain you are blocked.`);
		}
		reportVm("start", `${created.id.slice(0, 8)}; network: ${allow.join(", ") || "none"}`);
		vm = created;
		ctx?.ui.setStatus(
			"gondolin",
			ctx.ui.theme.fg("accent", `Gondolin: ${created.id.slice(0, 8)} (${GUEST_WORKSPACE})`),
		);
		ctx?.ui.notify(`Gondolin VM ready. ${localCwd} is mounted at ${GUEST_WORKSPACE}.`, "info");
		return created;
	}

	async function ensureVm(ctx?: ExtensionContext): Promise<VM> {
		if (vm) return vm;
		if (!vmStarting) {
			vmStarting = startVm(ctx).finally(() => {
				vmStarting = undefined;
			});
		}
		return vmStarting;
	}

	pi.on("session_shutdown", async (_event, ctx) => {
		const activeVm = vm;
		vm = undefined;
		vmStarting = undefined;
		if (!activeVm) return;
		ctx.ui.setStatus("gondolin", ctx.ui.theme.fg("muted", "Gondolin: stopping"));
		reportVm("stop", activeVm.id.slice(0, 8));
		try {
			await activeVm.close();
		} finally {
			ctx.ui.setStatus("gondolin", undefined);
		}
	});

	pi.registerCommand("gondolin", {
		description: "Show Gondolin VM status",
		handler: async (_args, ctx) => {
			const activeVm = await ensureVm(ctx);
			ctx.ui.notify(
				[
					`Gondolin VM: ${activeVm.id}`,
					`Host workspace: ${localCwd}`,
					`Guest workspace: ${GUEST_WORKSPACE}`,
					`Shell: ${shellPath}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createReadTool(GUEST_WORKSPACE, {
				operations: createGondolinReadOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createWriteTool(GUEST_WORKSPACE, {
				operations: createGondolinWriteOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createEditTool(GUEST_WORKSPACE, {
				operations: createGondolinEditOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createBashTool(GUEST_WORKSPACE, {
				operations: createGondolinBashOps(activeVm, localCwd, shellPath),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createLsTool(GUEST_WORKSPACE, {
				operations: createGondolinLsOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createFindTool(GUEST_WORKSPACE, {
				operations: createGondolinFindOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localGrep,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			return executeGondolinGrep(activeVm, localCwd, params, signal);
		},
	});

	pi.on("user_bash", async (_event, ctx) => {
		const activeVm = await ensureVm(ctx);
		return { operations: createGondolinBashOps(activeVm, localCwd, shellPath) };
	});

	pi.on("before_agent_start", async (event) => {
		// The VM boots on the first tool call; this only tells the model where its tools run.
		const localLine = `Current working directory: ${localCwd}`;
		const guestLine = `Current working directory: ${GUEST_WORKSPACE} (an isolated VM: your tools run there; the ship's repo ${localCwd} is mounted at ${GUEST_WORKSPACE}${HOST_MEMORY ? `, your memory folder at ${GUEST_MEMORY}` : ""}${HOST_SHIP_MEMORY ? `, the ship's shared memory at ${GUEST_SHIP_MEMORY}` : ""}; ${readonlyMounts().length ? "your skills, read-only at the paths listed for them; " : ""}nothing else on the host is visible; network only to the ship's allowlist; tests that need Docker run on the host through run_check)${browserNote()}`;
		const systemPrompt = event.systemPrompt.includes(localLine)
			? event.systemPrompt.replace(localLine, guestLine)
			: `${event.systemPrompt}\n\n${guestLine}`;
		return { systemPrompt };
	});
}
