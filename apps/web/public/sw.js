// Service Worker for do things (eventyr) PWA
// Provides offline caching, notification triggers, periodic sync, and notification click navigation.

const CACHE_NAME = "eventyr-cache-v1";
const PRECACHE_URLS = [
	"/",
	"/manifest.webmanifest",
	"/favicon.ico",
	"/icons/icon-192.png",
	"/icons/icon-512.png",
	"/icons/icon-maskable-512.png",
	"/icons/apple-touch-icon.png",
];

// Open or initialize IndexedDB inside Service Worker
function openDb() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open("eventyr-pwa", 1);
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

async function getFromMeta(key) {
	try {
		const db = await openDb();
		return new Promise((resolve) => {
			const tx = db.transaction("meta", "readonly");
			const store = tx.objectStore("meta");
			const req = store.get(key);
			req.onsuccess = () => resolve(req.result ? req.result.value : null);
			req.onerror = () => resolve(null);
		});
	} catch {
		return null;
	}
}

async function setInMeta(key, value) {
	try {
		const db = await openDb();
		return new Promise((resolve) => {
			const tx = db.transaction("meta", "readwrite");
			const store = tx.objectStore("meta");
			store.put({ key, value });
			tx.oncomplete = () => resolve(true);
			tx.onerror = () => resolve(false);
		});
	} catch {
		return false;
	}
}

async function getAllStarredEvents() {
	try {
		const db = await openDb();
		return new Promise((resolve) => {
			const tx = db.transaction("starred_events", "readonly");
			const store = tx.objectStore("starred_events");
			const req = store.getAll();
			req.onsuccess = () => resolve(req.result || []);
			req.onerror = () => resolve([]);
		});
	} catch {
		return [];
	}
}

function getTodayIso() {
	const now = new Date();
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

// 1. Install & Activate
self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE_NAME)
			.then((cache) => cache.addAll(PRECACHE_URLS))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys.map((key) => {
						if (key !== CACHE_NAME) return caches.delete(key);
					}),
				),
			)
			.then(() => self.clients.claim()),
	);
});

// 2. Network / Cache Fetch Handler
self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;

	const url = new URL(request.url);

	// Bypass cross-origin requests like analytics or widgets
	if (url.origin !== self.location.origin) return;

	// HTML Pages / Navigation: Network-first, fallback to cache
	if (request.mode === "navigate") {
		event.respondWith(
			fetch(request)
				.then((response) => {
					if (response && response.status === 200) {
						const clone = response.clone();
						caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
					}
					return response;
				})
				.catch(async () => {
					const cached = await caches.match(request);
					if (cached) return cached;
					const fallback = await caches.match("/");
					return fallback || new Response("Offline", { status: 503 });
				}),
		);
		return;
	}

	// Static assets and JSON data: Stale-while-revalidate
	event.respondWith(
		caches.match(request).then((cachedResponse) => {
			const fetchPromise = fetch(request)
				.then((networkResponse) => {
					if (networkResponse && networkResponse.status === 200) {
						const clone = networkResponse.clone();
						caches
							.open(CACHE_NAME)
							.then((cache) => cache.put(request, clone));
					}
					return networkResponse;
				})
				.catch(() => null);

			return cachedResponse || fetchPromise;
		}),
	);
});

// 3. Morning Digest Dispatcher
async function dispatchMorningDigest() {
	const today = getTodayIso();
	const lastSent = await getFromMeta("lastMorningDigestDate");
	if (lastSent === today) return;

	const stored = await getAllStarredEvents();
	if (!stored || stored.length === 0) return;

	// Find events happening today
	const todayEvents = stored
		.map((item) => item.event)
		.filter((e) => {
			if (!e) return false;
			const start = (e.datetime_iso || "").slice(0, 10);
			const end = (e.datetime_end_iso || e.datetime_iso || "").slice(0, 10);
			if (!start) return false;
			return start <= today && end >= today;
		});

	if (todayEvents.length === 0) return;

	let title = "";
	let body = "";

	if (todayEvents.length === 1) {
		const ev = todayEvents[0];
		title = `Today: ${ev.title}`;
		const timeStr = ev.datetime || "Today";
		const locStr = ev.location ? ` at ${ev.location}` : "";
		body = `${timeStr}${locStr}`;
	} else {
		title = `Today's Events (${todayEvents.length})`;
		body = todayEvents
			.slice(0, 3)
			.map((e) => `• ${e.title} (${e.datetime || "Today"})`)
			.join("\n");
		if (todayEvents.length > 3) {
			body += `\n+ ${todayEvents.length - 3} more`;
		}
	}

	await self.registration.showNotification(title, {
		body,
		icon: "/icons/icon-192.png",
		badge: "/icons/icon-192.png",
		tag: `daily-digest-${today}`,
		data: { url: "/#starred-section" },
	});

	await setInMeta("lastMorningDigestDate", today);
}

// 4. Periodic Sync Event (Installed PWAs in background)
self.addEventListener("periodicsync", (event) => {
	if (event.tag === "morning-digest") {
		event.waitUntil(dispatchMorningDigest());
	}
});

// 5. Client Messages
self.addEventListener("message", (event) => {
	const data = event.data;
	if (!data || typeof data !== "object") return;

	if (data.type === "CHECK_MORNING_DIGEST") {
		event.waitUntil(dispatchMorningDigest());
	} else if (data.type === "SCHEDULE_1H_NOTIFICATION") {
		const { title, body, notifyTime, eventUrl, id } = data;
		// Check for Notification Triggers support
		if (
			"showTrigger" in Notification.prototype &&
			typeof TimestampTrigger !== "undefined"
		) {
			try {
				self.registration.showNotification(title, {
					body,
					icon: "/icons/icon-192.png",
					badge: "/icons/icon-192.png",
					tag: `event-1h-${id}`,
					// @ts-ignore
					showTrigger: new TimestampTrigger(notifyTime),
					data: { url: eventUrl, eventId: id },
				});
			} catch (err) {
				console.warn("TimestampTrigger failed to schedule:", err);
			}
		}
	} else if (data.type === "CANCEL_1H_NOTIFICATION") {
		const { id } = data;
		self.registration
			.getNotifications({ tag: `event-1h-${id}` })
			.then((notifications) => {
				for (const n of notifications) {
					n.close();
				}
			});
	} else if (data.type === "TEST_NOTIFICATION") {
		self.registration.showNotification("Notifications Active", {
			body: "You'll receive a reminder 1 hour before bookmarked events and a morning digest at 8am.",
			icon: "/icons/icon-192.png",
			badge: "/icons/icon-192.png",
			tag: "test-notification",
			data: { url: "/#starred-section" },
		});
	}
});

// 6. Notification Click Navigation
self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const targetUrl = event.notification.data?.url || "/";

	event.waitUntil(
		self.clients
			.matchAll({ type: "window", includeUncontrolled: true })
			.then((windowClients) => {
				for (const client of windowClients) {
					if (client.url.includes(self.location.origin) && "focus" in client) {
						client.navigate(targetUrl);
						return client.focus();
					}
				}
				if (self.clients.openWindow) {
					return self.clients.openWindow(targetUrl);
				}
			}),
	);
});

