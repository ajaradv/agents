import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths.ts";

/**
 * fleet/config/models.json: the model roster. `aliases` name full model ids,
 * `surveyors` lists each reviewer's models, and `cursor` is the switch for the
 * whole Cursor lane ("off" drops every cursor/* model and harness). bin/launch
 * reads the same file.
 */
export type ModelsConfig = {
  cursor: "on" | "off";
  aliases: Record<string, string>;
  surveyors: Record<string, string[]>;
};

export const MODELS_PATH = join(ROOT, "fleet", "config", "models.json");

/** The roster; a missing or unreadable file means Cursor on and no aliases, as in bin/launch. */
export function readModels(path: string = MODELS_PATH): ModelsConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    /* defaults below */
  }
  const strings = (v: unknown): Record<string, string> =>
    v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string")) as Record<string, string> : {};
  const surveyors: Record<string, string[]> = {};
  if (raw.surveyors && typeof raw.surveyors === "object") {
    for (const [k, v] of Object.entries(raw.surveyors)) {
      if (Array.isArray(v)) surveyors[k] = v.map(String);
    }
  }
  return { cursor: raw.cursor === "off" ? "off" : "on", aliases: strings(raw.aliases), surveyors };
}

/** A full id for an alias; anything that is not an alias comes back unchanged. */
export function resolveAlias(id: string, models: ModelsConfig = readModels()): string {
  return models.aliases[id] ?? id;
}

/** Whether two model ids name the same model: the last two path segments match (provider prefixes differ). */
export function sameModel(a: string, b: string): boolean {
  const tail = (s: string) => s.split("/").slice(-2).join("/");
  return tail(a) === tail(b);
}

export function cursorOn(path: string = MODELS_PATH): boolean {
  return readModels(path).cursor === "on";
}
