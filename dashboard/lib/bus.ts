import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { aliceVault, fleetInboxRoot } from "./paths.ts";
import { escapeHtml } from "./quota.ts";

export async function lastBusLine(agentId: string): Promise<string | null> {
  try {
    const raw = await readFile(
      join(fleetInboxRoot(), agentId, "events.jsonl"),
      "utf8",
    );
    const lines = raw.trim().split("\n").filter(Boolean);
    return lines.length ? lines[lines.length - 1]! : null;
  } catch {
    return null;
  }
}

export async function busCount24h(): Promise<number> {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  let n = 0;
  const inbox = fleetInboxRoot();
  let dirs: string[];
  try {
    dirs = (await readdir(inbox, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return 0;
  }
  for (const id of dirs) {
    try {
      const raw = await readFile(join(inbox, id, "events.jsonl"), "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line) as { ts?: string };
          if (o.ts && Date.parse(o.ts) >= since) n++;
        } catch {
          /* skip */
        }
      }
    } catch {
      /* skip */
    }
  }
  return n;
}

export async function planDraftCount(): Promise<number | null> {
  const vault = aliceVault();
  const base = join(vault, "fleet", "plans");
  let n = 0;
  try {
    const cats = await readdir(base, { withFileTypes: true });
    for (const cat of cats) {
      if (!cat.isDirectory()) continue;
      const files = await readdir(join(base, cat.name));
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        try {
          const body = await readFile(join(base, cat.name, f), "utf8");
          if (/status:\s*draft/i.test(body)) n++;
        } catch {
          /* skip */
        }
      }
    }
    return n;
  } catch {
    return null;
  }
}

export async function metricsStripHtml(): Promise<string> {
  const [events, plans] = await Promise.all([busCount24h(), planDraftCount()]);
  const plansBit =
    plans === null
      ? "Plans: vault unreadable"
      : `Draft plans: ${plans}`;
  return `<div class="kpis"><div class="kpi"><span class="muted">Bus events, 24h</span><b>${events}</b></div><div class="kpi"><span class="muted">Vault</span><b>${escapeHtml(plansBit)}</b></div></div>`;
}
