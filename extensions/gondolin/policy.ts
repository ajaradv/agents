/** Pure policy for the fleet Gondolin extension (no pi imports, so it can be tested). */

export const GUEST_CACHE = "/cache";

/**
 * The only environment commands in the VM get. The host's environment (keys,
 * FLEET_* tokens, macOS PATH) never crosses; the guest keeps its own PATH.
 */
export function guestEnv(agentId = process.env.FLEET_AGENT_ID ?? "crewmate", cache = !!process.env.FLEET_VM_CACHE): Record<string, string> {
	return {
		// The crewmate's cache folder (/cache) keeps pre-commit's hook environments
		// between VMs, so a new VM does not rebuild them before its first commit.
		...(cache ? { PRE_COMMIT_HOME: `${GUEST_CACHE}/pre-commit` } : {}),
		HOME: "/root",
		LANG: "C.UTF-8",
		TERM: "xterm-256color",
		CI: "1",
		GIT_AUTHOR_NAME: agentId,
		GIT_AUTHOR_EMAIL: `${agentId}@fleet.local`,
		GIT_COMMITTER_NAME: agentId,
		GIT_COMMITTER_EMAIL: `${agentId}@fleet.local`,
	};
}

/** The ship's allowlist: comma-separated hostnames, `*.` wildcards allowed; empty means no network. */
export function allowedHosts(raw = process.env.FLEET_VM_ALLOW ?? ""): string[] {
	return raw
		.split(",")
		.map((h) => h.trim().toLowerCase())
		.filter((h) => /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h));
}

export function hostAllowed(host: string, allow: string[]): boolean {
	const h = host.toLowerCase().split(":")[0] ?? "";
	return allow.some((a) => a === h || (a.startsWith("*.") && h.endsWith(a.slice(1))));
}

/** VM size for VM.create: FLEET_VM_RAM (qemu syntax, for example 2G) when set; Gondolin's default (1G) otherwise. */
export function vmSize(raw = process.env.FLEET_VM_RAM ?? ""): { memory?: string } {
	return /^\d{1,3}[MG]$/.test(raw) ? { memory: raw } : {};
}

/** The line a browser-image crewmate's prompt gets about taking screenshots (R4e); empty otherwise. */
export function browserNote(on = process.env.FLEET_VM_BROWSER === "1"): string {
	if (!on) return "";
	return "\n\nScreenshots: this VM has Chromium. `shot <url-or-file>` saves desktop (1440x900) and mobile (390x844) PNGs under /cache/shots and prints their paths, the page's console errors, and failed requests (`--full` whole page, `--mobile` or `--desktop` one size, `--selector CSS`, `--dark`, `shot --help`). Read a PNG with the read tool to see it; show it to the captain with the canvas (kind image, the same /cache/shots path). Interactive checks (click, fill, read the page's structure): `cdt open <url>`, then `cdt snapshot`, `cdt click @<ref>`, `cdt fill @<ref> \"text\"`, `cdt screenshot <path>` (`cdt --help`). A dev server you start in the VM is reachable at localhost; the Mac's servers and the dashboard are not.";
}

/**
 * A guest path as the host sees it, for host-side tools (the canvas) given a
 * path from a VM crewmate: /workspace -> the repo or worktree, /memory,
 * /ship-memory, /cache -> their host folders. Other paths come back unchanged.
 */
export function guestToHost(p: string, mounts: { workspace: string; memory?: string; shipMemory?: string; cache?: string }): string {
	const pairs: [string, string | undefined][] = [
		["/workspace", mounts.workspace],
		["/ship-memory", mounts.shipMemory],
		["/memory", mounts.memory],
		[GUEST_CACHE, mounts.cache],
	];
	for (const [guest, host] of pairs) {
		if (!host) continue;
		if (p === guest) return host;
		if (p.startsWith(`${guest}/`)) {
			const rest = p.slice(guest.length + 1).split("/");
			if (rest.includes("..")) return p;
			return [host.replace(/\/$/, ""), ...rest].join("/");
		}
	}
	return p;
}

/** Host folders mounted read-only at the same path in the guest (FLEET_VM_RO_MOUNTS, ":"-separated absolute paths). */
export function readonlyMounts(raw = process.env.FLEET_VM_RO_MOUNTS ?? ""): string[] {
	return [...new Set(raw.split(":").map((d) => d.trim().replace(/\/+$/, "")).filter((d) => d.startsWith("/") && d.length > 1 && !d.split("/").includes("..")))];
}
