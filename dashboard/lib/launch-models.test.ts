import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LAUNCH = join(import.meta.dir, "..", "..", "bin", "launch");

// Loads bin/launch, points its ROOT (models.json) and FLEET_INBOX at a temp dir, and runs `body`,
// which sets `out`. Keys in the environment are fake; the process env is never printed.
function run(root: string, body: string): Record<string, unknown> {
  const py = `import importlib.util, importlib.machinery, json, os, sys
from pathlib import Path
from datetime import datetime, timedelta, timezone
l = importlib.machinery.SourceFileLoader("launch", sys.argv[1]); s = importlib.util.spec_from_loader("launch", l); m = importlib.util.module_from_spec(s); l.exec_module(m)
root = Path(sys.argv[2]); m.ROOT = root
os.environ["FLEET_INBOX"] = str(root / "inbox")
for k in ("CURSOR_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "FM_SKIP_HARNESSES"): os.environ.pop(k, None)
os.environ["CURSOR_API_KEY"] = "fake"; os.environ["OPENROUTER_API_KEY"] = "fake"
out = {}
def snapshot(api, spend, hours=1):
    d = root / "inbox" / ".node"; d.mkdir(parents=True, exist_ok=True)
    at = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    (d / "quota-last.json").write_text(json.dumps({"at": at, "cursor": {"api_usage": api, "spend_limit": spend, "included_usage": 5, "auto_usage": 5}}))
def reset():
    import shutil; shutil.rmtree(root / "inbox", ignore_errors=True); m.LAST_FALLBACK_REASON = ""
${body}
print(json.dumps(out))`;
  const r = Bun.spawnSync(["/usr/bin/python3", "-B", "-W", "error", "-c", py, LAUNCH, root], { env: { ...process.env } });
  expect(r.stderr.toString().replace(/^launch: .*\n/gm, "")).toBe("");
  return JSON.parse(r.stdout.toString()) as Record<string, unknown>;
}

let root = "";
const models = (cursor: "on" | "off") =>
  writeFileSync(
    join(root, "fleet", "config", "models.json"),
    JSON.stringify({ cursor, aliases: { "grok-4.7": "cursor/grok-4.7@256k", sol: "openrouter/openai/gpt-6.1-sol", "deepseek-v4-pro": "openrouter/deepseek/deepseek-v4-pro", luna: "openrouter/openai/gpt-6-luna", "composer-2.5": "cursor/composer-2.5" } }),
  );

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "launch-models-"));
  mkdirSync(join(root, "fleet", "config"), { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ARCH = `{"models": ["grok-4.7", "sol", "deepseek-v4-pro"]}`;

describe("bin/launch: pick_model", () => {
  test("Cursor off skips cursor/*, records backup with the reason; Cursor on picks Grok", () => {
    models("off");
    const off = run(root, `reset()
out["pick"] = m.pick_model(${ARCH}, "architect")
out["reason"] = m.LAST_FALLBACK_REASON
m.record_running_model("architect", m.agent_models(${ARCH})[0], out["pick"])
out["running"] = json.loads((root / "inbox" / "architect" / "model-running.json").read_text())`);
    expect(off.pick).toBe("openrouter/openai/gpt-6.1-sol");
    expect(off.reason).toBe("Cursor is off");
    expect(off.running).toMatchObject({ model: "openrouter/openai/gpt-6.1-sol", configured: "cursor/grok-4.7@256k", backup: true, reason: "Cursor is off" });
    models("on");
    const on = run(root, `reset()
out["pick"] = m.pick_model(${ARCH}, "architect")
out["reason"] = m.LAST_FALLBACK_REASON`);
    expect(on.pick).toBe("cursor/grok-4.7@256k");
    expect(on.reason).toBe("");
  });

  test("aliases resolve, full ids pass through, a missing models.json means Cursor on", () => {
    models("on");
    const r = run(root, `out["a"] = m.agent_models({"models": ["luna", "cursor/composer-2.5"]})
(root / "fleet" / "config" / "models.json").unlink()
out["none"] = m.agent_models({"models": ["luna"]})
out["on"] = m.load_models_config()["cursor"]`);
    expect(r.a).toEqual(["openrouter/openai/gpt-6-luna", "cursor/composer-2.5"]);
    expect(r.none).toEqual(["luna"]);
    expect(r.on).toBe("on");
  });

  test("a missing key falls through, to the third entry when needed", () => {
    models("on");
    const r = run(root, `reset()
os.environ.pop("CURSOR_API_KEY")
out["second"] = m.pick_model(${ARCH}, "architect")
out["reason"] = m.LAST_FALLBACK_REASON
os.environ.pop("OPENROUTER_API_KEY")
out["last"] = m.pick_model(${ARCH}, "architect")`);
    expect(r.second).toBe("openrouter/openai/gpt-6.1-sol");
    expect(r.reason).toBe("CURSOR_API_KEY is not set");
    expect(r.last).toBe("openrouter/deepseek/deepseek-v4-pro");
  });

  test("the model that failed today is skipped; yesterday's marker is not", () => {
    models("on");
    const r = run(root, `reset()
d = root / "inbox" / "architect"; d.mkdir(parents=True)
day = datetime.now().date().isoformat()
(d / "model-fallback.json").write_text(json.dumps({"model": "cursor/grok-4.7@256k", "day": day, "reason": "billing"}))
out["today"] = m.pick_model(${ARCH}, "architect")
out["reason"] = m.LAST_FALLBACK_REASON
(d / "model-fallback.json").write_text(json.dumps({"model": "cursor/grok-4.7@256k", "day": "2020-01-01", "reason": "billing"}))
out["old"] = m.pick_model(${ARCH}, "architect")`);
    expect(r.today).toBe("openrouter/openai/gpt-6.1-sol");
    expect(r.reason).toBe("cursor/grok-4.7@256k failed today: billing");
    expect(r.old).toBe("cursor/grok-4.7@256k");
  });

  test("legacy model and fallback_model still work", () => {
    models("on");
    const r = run(root, `reset()
legacy = {"model": "openrouter/deepseek/deepseek-v4-pro", "fallback_model": "cursor/composer-2.5"}
out["models"] = m.agent_models(legacy)
out["pick"] = m.pick_model(legacy, "x")
os.environ.pop("OPENROUTER_API_KEY")
out["backup"] = m.pick_model(legacy, "x")
out["reason"] = m.LAST_FALLBACK_REASON
out["single"] = m.pick_model({"model": "openrouter/anthropic/claude-sonnet-5.5"}, "x")
out["none"] = m.pick_model({}, "x")`);
    expect(r.models).toEqual(["openrouter/deepseek/deepseek-v4-pro", "cursor/composer-2.5"]);
    expect(r.pick).toBe("openrouter/deepseek/deepseek-v4-pro");
    expect(r.backup).toBe("cursor/composer-2.5");
    expect(r.reason).toBe("OPENROUTER_API_KEY is not set");
    expect(r.single).toBe("openrouter/anthropic/claude-sonnet-5.5");
    expect(r.none).toBeNull();
  });

  test("keys_needed covers every listed provider, a third included", () => {
    models("on");
    const r = run(root, `out["keys"] = sorted(m.keys_needed({"models": ["composer-2.5", "deepseek-v4-pro", "google/gemini-3.7-flash"]}))`);
    expect(r.keys).toEqual(["CURSOR_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]);
  });
});

describe("bin/launch: an exhausted Cursor", () => {
  const agent = `{"models": ["composer-2.5", "deepseek-v4-pro", "luna"]}`;

  test("a fresh snapshot with api_usage and spend_limit at 0 skips Cursor", () => {
    models("on");
    const r = run(root, `reset()
snapshot(0, 0)
out["out"] = m.cursor_quota_out()
out["pick"] = m.pick_model(${agent}, "shipwright")
out["reason"] = m.LAST_FALLBACK_REASON
out["unusable"] = m.cursor_unusable()`);
    expect(r.out).toBe(true);
    expect(r.pick).toBe("openrouter/deepseek/deepseek-v4-pro");
    expect(r.reason).toBe("Cursor quota is out");
    expect(r.unusable).toBe("Cursor quota is out");
  });

  test("a 7-hour-old snapshot, api_usage above 0, or no snapshot changes nothing", () => {
    models("on");
    const r = run(root, `reset()
out["none"] = m.cursor_quota_out()
snapshot(0, 0, hours=7)
out["old"] = m.cursor_quota_out()
snapshot(3, 0)
out["api"] = m.cursor_quota_out()
out["pick"] = m.pick_model(${agent}, "shipwright")
snapshot(0, 4)
out["spend"] = m.cursor_quota_out()
(root / "inbox" / ".node" / "quota-last.json").write_text("{")
out["broken"] = m.cursor_quota_out()`);
    expect([r.none, r.old, r.api, r.spend, r.broken]).toEqual([false, false, false, false, false]);
    expect(r.pick).toBe("cursor/composer-2.5");
  });
});

describe("bin/launch: FM_SKIP_HARNESSES", () => {
  const body = (setup: string) => `reset()
${setup}
m.skip_cursor_harness()
out["skip"] = os.environ.get("FM_SKIP_HARNESSES")`;

  test("set to cursor while Cursor is off or out of quota, left alone otherwise", () => {
    models("off");
    expect(run(root, body("")).skip).toBe("cursor");
    models("on");
    expect(run(root, body("snapshot(0, 0)")).skip).toBe("cursor");
    expect(run(root, body("")).skip).toBeNull();
  });

  test("keeps a list the caller already set", () => {
    models("off");
    expect(run(root, body('os.environ["FM_SKIP_HARNESSES"] = "kimi,cursor"')).skip).toBe("kimi,cursor");
    expect(run(root, body('os.environ["FM_SKIP_HARNESSES"] = "kimi"')).skip).toBe("kimi,cursor");
  });
});
