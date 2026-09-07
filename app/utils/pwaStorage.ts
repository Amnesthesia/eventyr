import type { Event } from "../types";

export interface StoredStarredItem {
	id: string;
	event: Event;
	notifyTime?: number;
	notified1h?: boolean;
}

const DB_NAME = "eventyr-pwa";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		if (typeof indexedDB === "undefined") {
			return reject(new Error("IndexedDB not supported"));
		}
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains("starred_events")) {
				db.createObjectStore("starred_events", { keyPath: "id" });
			}
			if (!db.objectStoreNames.contains("meta")) {
				db.createObjectStore("meta", { keyPath: "key" });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

export async function putStarredEvent(
	id: string,
	event: Event,
	notifyTime?: number,
): Promise<void> {
	try {
		const db = await openDb();
		return new Promise((resolve, reject) => {
			const tx = db.transaction("starred_events", "readwrite");
			const store = tx.objectStore("starred_events");
			const item: StoredStarredItem = { id, event, notifyTime };
			store.put(item);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	} catch {
		// Ignore storage errors if private mode/quota
	}
}

export async function deleteStarredEvent(id: string): Promise<void> {
	try {
		const db = await openDb();
		return new Promise((resolve, reject) => {
			const tx = db.transaction("starred_events", "readwrite");
			const store = tx.objectStore("starred_events");
			store.delete(id);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	} catch {
		// Ignore
	}
}

export async function getAllStarredItems(): Promise<StoredStarredItem[]> {
	try {
		const db = await openDb();
		return new Promise((resolve, reject) => {
			const tx = db.transaction("starred_events", "readonly");
			const store = tx.objectStore("starred_events");
			const req = store.getAll();
			req.onsuccess = () => resolve((req.result as StoredStarredItem[]) || []);
			req.onerror = () => reject(req.error);
		});
	} catch {
		return [];
	}
}

export async function getPwaMeta<T>(key: string): Promise<T | null> {
	try {
		const db = await openDb();
		return new Promise((resolve) => {
			const tx = db.transaction("meta", "readonly");
			const store = tx.objectStore("meta");
			const req = store.get(key);
			req.onsuccess = () =>
				resolve(req.result ? (req.result.value as T) : null);
			req.onerror = () => resolve(null);
		});
	} catch {
		return null;
	}
}

export async function setPwaMeta(key: string, value: unknown): Promise<void> {
	try {
		const db = await openDb();
		return new Promise((resolve) => {
			const tx = db.transaction("meta", "readwrite");
			const store = tx.objectStore("meta");
			store.put({ key, value });
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
		});
	} catch {
		// Ignore
	}
}
