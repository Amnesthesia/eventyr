import { useCallback, useState } from "react";

function load(key: string): Set<string> {
	if (typeof localStorage === "undefined") return new Set();
	try {
		const raw = localStorage.getItem(key);
		return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
	} catch {
		return new Set();
	}
}

/**
 * A Set<string> of event ids persisted in localStorage. Backs both the saved
 * (starred) events and the ones hidden by swiping left — same shape, same
 * storage rules, so it is one hook with two keys rather than two copies.
 */
export function useStoredSet(key: string) {
	const [set, setSet] = useState<Set<string>>(() => load(key));

	const update = useCallback(
		(fn: (next: Set<string>) => void) => {
			setSet((prev) => {
				const next = new Set(prev);
				fn(next);
				try {
					localStorage.setItem(key, JSON.stringify([...next]));
				} catch {
					// Private mode or storage disabled: still works for this view.
				}
				return next;
			});
		},
		[key],
	);

	const add = useCallback((id: string) => update((s) => s.add(id)), [update]);
	const remove = useCallback(
		(id: string) => update((s) => s.delete(id)),
		[update],
	);
	const toggle = useCallback(
		(id: string) =>
			update((s) => {
				if (!s.delete(id)) s.add(id);
			}),
		[update],
	);
	const clear = useCallback(() => update((s) => s.clear()), [update]);

	return { set, add, remove, toggle, clear };
}
