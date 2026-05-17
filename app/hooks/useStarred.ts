import { useCallback, useState } from "react";

const STORAGE_KEY = "eventyr:starred";

function load(): Set<string> {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
	} catch {
		return new Set();
	}
}

function save(starred: Set<string>) {
	localStorage.setItem(STORAGE_KEY, JSON.stringify([...starred]));
}

export function useStarred() {
	const [starred, setStarred] = useState<Set<string>>(load);

	const toggle = useCallback((id: string) => {
		setStarred((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			save(next);
			return next;
		});
	}, []);

	return { starred, toggle };
}
