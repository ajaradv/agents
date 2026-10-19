/**
 * subagent: isolated sub-agents (separate pi processes with their own context)
 * for agents whose skills need them, such as the designer's impeccable critique,
 * which runs its design review and its detector evidence as two independent
 * assessments. Pi's own example extension, vendored in extensions/subagent/.
 *
 * Agent definitions come from agents/subagents/*.md (FLEET_SUBAGENTS_DIR, set
 * here). A sub-agent inherits the caller's model unless its definition names
 * one. What sub-agents spend is added to the caller's turn cost by the agent
 * host, so it counts toward the daily budget.
 */
import { join } from "node:path";

process.env.FLEET_SUBAGENTS_DIR ??= join(import.meta.dirname, "..", "agents", "subagents");

export { default } from "./subagent/index.ts";
