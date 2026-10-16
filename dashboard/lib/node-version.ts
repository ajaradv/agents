import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A fingerprint of the code the fleet node runs (node.ts and dashboard/lib,
 * tests excluded). The node reports the one it started with; the dashboard
 * computes its own at start. A difference means the node is running older
 * code than the dashboard, so the dashboard restarts it once no agent is busy
 * (a dashboard restart alone never restarts the node, by design).
 */
function compute(): string {
  const dir = import.meta.dir;
  const files = ["../node.ts", ...readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort()];
  const h = createHash("sha1");
  for (const f of files) {
    try {
      h.update(f).update(readFileSync(join(dir, f)));
    } catch {
      /* a file removed since start */
    }
  }
  return h.digest("hex").slice(0, 12);
}

export const NODE_CODE_VERSION = compute();
