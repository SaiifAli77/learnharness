/**
 * The local agent preference adapter (FORK.md, "Local agent connections"):
 * data/local-agents.json (next to config.SETTINGS_FILE), under the LH_DATA_DIR
 * seam. Holds only the learner's enabled/background-use choices per
 * locally installed runtime — never a credential (the runtimes own their
 * sign-in). Absent/corrupt file = no choices yet; unknown providers are
 * dropped on read; writes go through upstream's writeFileAtomicSync.
 */

import fs from "node:fs";
import path from "node:path";
import { SETTINGS_FILE } from "../../config.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";
import { LOCAL_AGENTS, type LocalAgentPreferences, type LocalAgentPreferenceStore, type LocalAgentProviderId } from "../core/contracts/local-agents.ts";

/** Same data root as settings.json (the LH_DATA_DIR seam), without editing upstream config.ts. */
const LOCAL_AGENTS_FILE = path.join(path.dirname(SETTINGS_FILE), "local-agents.json");

type Record_ = Partial<Record<LocalAgentProviderId, LocalAgentPreferences>>;

function read(): Record_ {
	let parsed: unknown;
	try { parsed = JSON.parse(fs.readFileSync(LOCAL_AGENTS_FILE, "utf-8")); } catch { return {}; }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const out: Record_ = {};
	for (const { providerId } of LOCAL_AGENTS) {
		const entry = (parsed as Record<string, unknown>)[providerId] as Partial<LocalAgentPreferences> | undefined;
		if (!entry || typeof entry !== "object") continue;
		out[providerId] = { enabled: entry.enabled === true, allowBackgroundUse: entry.allowBackgroundUse !== false };
	}
	return out;
}

function write(providerId: LocalAgentProviderId, preferences: LocalAgentPreferences): void {
	const next = { ...read(), [providerId]: { enabled: preferences.enabled === true, allowBackgroundUse: preferences.allowBackgroundUse !== false } };
	fs.mkdirSync(path.dirname(LOCAL_AGENTS_FILE), { recursive: true });
	writeFileAtomicSync(LOCAL_AGENTS_FILE, `${JSON.stringify(next, null, "\t")}\n`);
}

export const localAgentPreferenceStore: LocalAgentPreferenceStore = { read, write };
