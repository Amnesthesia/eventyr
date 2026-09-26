// Where stated tag preferences are kept in this browser. The preferences
// themselves, and what they do to ordering, are @dothingslol/core/tagPrefs;
// only the storage is web-specific.

import { STORAGE_KEYS } from "@dothingslol/core/storageKeys";
import type { TagPrefs } from "@dothingslol/core/tagPrefs";

const KEY = STORAGE_KEYS.tagPrefs;

export function loadTagPrefs(): TagPrefs {
	if (typeof localStorage === "undefined") return {};
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		// Stored values are read back from a place the user can edit; keep only
		// the two the rest of this file knows how to mean.
		const out: TagPrefs = {};
		for (const [tag, value] of Object.entries(parsed)) {
			if (value === 1 || value === -1) out[tag] = value;
		}
		return out;
	} catch {
		return {};
	}
}

export function saveTagPrefs(prefs: TagPrefs): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(prefs));
	} catch {
		// Private mode or storage disabled: still works for this view.
	}
}
