/** Pure policy for the fleet Gondolin extension (no pi imports, so it can be tested). */

/**
 * The only environment commands in the VM get. The host's environment (keys,
 * FLEET_* tokens, macOS PATH) never crosses; the guest keeps its own PATH.
 */
export function guestEnv(agentId = process.env.FLEET_AGENT_ID ?? "crewmate"): Record<string, string> {
	return {
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
