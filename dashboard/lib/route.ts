import { join } from "node:path";
import { agentKeyEnv } from "./fleet-env.ts";
import { spawnTimed } from "./proc.ts";
import { ROOT } from "./paths.ts";

/** Parsed output of bin/fleet-route-resolve.sh. status "off" = Jev not enabled or nothing sent. */
export type RouteResult = {
  status: "clear" | "ambiguous" | "escalate" | "error" | "off";
  choice?: string;
  target?: string;
  sendTo?: string;
  confidence?: number;
  probabilities: Array<{ key: string; p: number }>;
  reason?: string;
};

export function parseRouteOutput(stdout: string, stderr = ""): RouteResult {
  const fields: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s{2}([a-z_]+):\s*(.*)$/);
    if (m?.[1]) fields[m[1]] = m[2] ?? "";
  }
  if (!fields.status) {
    const off = stderr.match(/route-resolve: off \((.*)\)/)?.[1];
    return { status: "off", probabilities: [], reason: off ?? (stderr.trim().slice(0, 200) || "routing unavailable") };
  }
  const probabilities = (fields.probabilities ?? "")
    .split(/\s+/)
    .map((kv) => kv.split("="))
    .filter((kv) => kv.length === 2 && kv[0])
    .map(([key, p]) => ({ key: key!, p: Number(p) }));
  return {
    status: fields.status as RouteResult["status"],
    choice: fields.choice,
    target: fields.target,
    sendTo: fields.send_to,
    confidence: fields.confidence ? Number(fields.confidence) : undefined,
    probabilities,
    reason: fields.reason,
  };
}

export async function resolveRoute(text: string): Promise<RouteResult> {
  const res = await spawnTimed(["bash", join(ROOT, "bin", "fleet-route-resolve.sh"), "-"], {
    timeoutMs: 15_000,
    stdin: text,
    cwd: ROOT,
    // The Jev key from the service account, so the script never reads the 1Password mount.
    env: { ...process.env, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY || (await agentKeyEnv()).TYPESAFE_API_KEY || "" },
  });
  if (res.timedOut) return { status: "error", probabilities: [], reason: "route resolver timed out" };
  if (res.exitCode !== 0) return { status: "error", probabilities: [], reason: res.stderr.trim().slice(0, 200) };
  return parseRouteOutput(res.stdout, res.stderr);
}
