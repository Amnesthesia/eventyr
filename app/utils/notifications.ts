import { eventPath } from "../../src/shared.ts";
import { eventId } from "../context";
import type { Event } from "../types";
import { todayIso } from "./dates";
import {
	deleteStarredEvent,
	getPwaMeta,
	putStarredEvent,
	setPwaMeta,
} from "./pwaStorage";

// Active in-memory timers for the current session
const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Checks if the web app is running in standalone PWA mode.
 */
export function isStandalone(): boolean {
	if (typeof window === "undefined") return false;
	return (
		window.matchMedia("(display-mode: standalone)").matches ||
		(window.navigator as unknown as { standalone?: boolean }).standalone ===
			true ||
		document.referrer.includes("android-app://")
	);
}

/**
 * Checks if device is a mobile phone (by user agent or small screen width).
 */
export function isMobilePhone(): boolean {
	if (typeof window === "undefined") return false;
	return (
		/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
		window.matchMedia("(max-width: 768px)").matches
	);
}

/**
 * Whether the Notification API and Service Worker are available.
 */
export function canUseNotifications(): boolean {
	return (
		typeof window !== "undefined" &&
		"Notification" in window &&
		"serviceWorker" in navigator
	);
}

/**
 * Current notification permission state.
 */
export function getNotificationPermission(): NotificationPermission {
	if (!canUseNotifications()) return "denied";
	return Notification.permission;
}

/**
 * Prompts user for notification permission and registers periodic sync if available.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
	if (!canUseNotifications()) return "denied";
	try {
		const permission = await Notification.requestPermission();
		if (permission === "granted") {
			// Register Periodic Background Sync for morning digest if supported
			const reg = await getSwRegistration();
			if (reg && "periodicSync" in reg) {
				try {
					// @ts-expect-error
					await reg.periodicSync.register("morning-digest", {
						minInterval: 12 * 60 * 60 * 1000,
					});
				} catch {
					// Periodic sync permission or support not available
				}
			}
		}
		return permission;
	} catch {
		return "denied";
	}
}

/**
 * Returns the active ServiceWorkerRegistration.
 */
export async function getSwRegistration(): Promise<ServiceWorkerRegistration | null> {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
		return null;
	}
	try {
		return await navigator.serviceWorker.ready;
	} catch {
		return null;
	}
}

/**
 * Computes timestamp for 1 hour before an event.
 * If event has no time component (date only), defaults to 8:00 AM on that day.
 */
export function calculate1hReminderTime(datetime_iso: string): number | null {
	if (!datetime_iso) return null;

	// Timed ISO (e.g. 2026-09-07T11:00:00 or 2026-09-07T11:00:00+10:00)
	if (datetime_iso.includes("T")) {
		const startTime = new Date(datetime_iso).getTime();
		if (Number.isNaN(startTime)) return null;
		return startTime - 60 * 60 * 1000;
	}

	// Date-only ISO (e.g. 2026-09-07) -> default to 8:00 AM on that day
	const match = datetime_iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!match) return null;
	const [, y, m, d] = match;
	const date = new Date(
		Number(y),
		Number(m) - 1,
		Number(d),
		8,
		0,
		0,
		0,
	).getTime();
	if (Number.isNaN(date)) return null;
	return date;
}

/**
 * Format 12-hour time string from event ISO (e.g. "11:00 AM").
 */
export function formatEventTime(datetime_iso: string): string {
	if (!datetime_iso?.includes("T")) return "Today";
	try {
		const date = new Date(datetime_iso);
		let hours = date.getHours();
		const minutes = String(date.getMinutes()).padStart(2, "0");
		const ampm = hours >= 12 ? "PM" : "AM";
		hours = hours % 12 || 12;
		return `${hours}:${minutes} ${ampm}`;
	} catch {
		return "Today";
	}
}

/**
 * Filter events for the morning digest: starts on or overlaps today.
 */
export function filterEventsForMorningDigest(
	events: Event[],
	today: string,
): Event[] {
	return events.filter((e) => {
		if (!e) return false;
		const start = (e.datetime_iso || "").slice(0, 10);
		const end = (e.datetime_end_iso || e.datetime_iso || "").slice(0, 10);
		if (!start) return false;
		return start <= today && end >= today;
	});
}

/**
 * Format notification title and body for the morning digest.
 */
export function formatMorningDigest(events: Event[]): {
	title: string;
	body: string;
} {
	if (events.length === 0) {
		return { title: "Today's Events", body: "No bookmarked events today." };
	}
	if (events.length === 1) {
		const ev = events[0];
		const timeStr = ev.datetime || formatEventTime(ev.datetime_iso);
		const locStr = ev.location ? ` at ${ev.location}` : "";
		return {
			title: `Today: ${ev.title}`,
			body: `${timeStr}${locStr}`,
		};
	}

	const title = `Today's Events (${events.length})`;
	const lines = events
		.slice(0, 3)
		.map(
			(e) => `• ${e.title} (${e.datetime || formatEventTime(e.datetime_iso)})`,
		);
	if (events.length > 3) {
		lines.push(`+ ${events.length - 3} more coming up today`);
	}
	return { title, body: lines.join("\n") };
}

/**
 * Schedules a notification 1 hour before an event starts.
 */
export async function schedule1hReminder(
	event: Event,
	cityKey: string,
	autoPrompt = false,
): Promise<void> {
	if (!event) return;
	const id = eventId(event);
	const notifyTime = calculate1hReminderTime(event.datetime_iso);

	// Persist to IndexedDB so SW and PWA retain full event metadata
	await putStarredEvent(id, event, notifyTime || undefined);

	if (!canUseNotifications()) return;

	if (autoPrompt && Notification.permission === "default") {
		await requestNotificationPermission();
	}

	if (Notification.permission !== "granted") return;
	if (!notifyTime || notifyTime <= Date.now()) return;

	const delay = notifyTime - Date.now();
	const eventUrl = eventPath(cityKey, event);
	const timeStr = formatEventTime(event.datetime_iso);
	const title = `Upcoming: ${event.title}`;
	const body = `Starts in 1 hour (${timeStr})${event.location ? ` at ${event.location}` : ""}`;

	// Clear any existing session timer for this event
	if (activeTimers.has(id)) {
		clearTimeout(activeTimers.get(id));
		activeTimers.delete(id);
	}

	// 1. Session in-memory timer (if starting within 24 hours)
	if (delay < 24 * 60 * 60 * 1000) {
		const timer = setTimeout(async () => {
			const reg = await getSwRegistration();
			if (reg) {
				reg.showNotification(title, {
					body,
					icon: "/icons/icon-192.png",
					badge: "/icons/icon-192.png",
					tag: `event-1h-${id}`,
					data: { url: eventUrl, eventId: id },
				});
			} else {
				new Notification(title, {
					body,
					icon: "/icons/icon-192.png",
					tag: `event-1h-${id}`,
				});
			}
			activeTimers.delete(id);
		}, delay);
		activeTimers.set(id, timer);
	}

	// 2. Delegate to Service Worker for Notification Triggers (WICG TimestampTrigger)
	const reg = await getSwRegistration();
	if (reg && navigator.serviceWorker.controller) {
		navigator.serviceWorker.controller.postMessage({
			type: "SCHEDULE_1H_NOTIFICATION",
			title,
			body,
			notifyTime,
			eventUrl,
			id,
		});
	}
}

/**
 * Cancels a scheduled 1-hour notification.
 */
export async function cancel1hReminder(id: string): Promise<void> {
	if (activeTimers.has(id)) {
		clearTimeout(activeTimers.get(id));
		activeTimers.delete(id);
	}
	await deleteStarredEvent(id);

	if (canUseNotifications() && navigator.serviceWorker.controller) {
		navigator.serviceWorker.controller.postMessage({
			type: "CANCEL_1H_NOTIFICATION",
			id,
		});
	}
}

/**
 * Checks and triggers the start-of-day morning notification (at 8:00 AM).
 */
export async function checkAndNotifyMorningDigest(
	allEvents: Event[],
	starredIds: Set<string>,
	cityKey: string,
): Promise<void> {
	if (!canUseNotifications() || Notification.permission !== "granted") return;

	const today = todayIso();
	const lastSent = await getPwaMeta<string>("lastMorningDigestDate");
	if (lastSent === today) return;

	// Resolve bookmarked events
	const starredEvents = allEvents.filter((e) => starredIds.has(eventId(e)));
	const todayEvents = filterEventsForMorningDigest(starredEvents, today);
	if (todayEvents.length === 0) return;

	const now = new Date();
	const currentHour = now.getHours();

	// 8:00 AM or later: Dispatch immediately
	if (currentHour >= 8) {
		const reg = await getSwRegistration();
		const { title, body } = formatMorningDigest(todayEvents);
		if (reg) {
			await reg.showNotification(title, {
				body,
				icon: "/icons/icon-192.png",
				badge: "/icons/icon-192.png",
				tag: `daily-digest-${today}`,
				data: { url: "/#starred-section" },
			});
		} else {
			new Notification(title, {
				body,
				icon: "/icons/icon-192.png",
				tag: `daily-digest-${today}`,
			});
		}
		await setPwaMeta("lastMorningDigestDate", today);
		return;
	}

	// Before 8:00 AM: Schedule for 8:00 AM today
	const target8am = new Date(
		now.getFullYear(),
		now.getMonth(),
		now.getDate(),
		8,
		0,
		0,
		0,
	).getTime();
	const delay = target8am - now.getTime();
	if (delay > 0) {
		setTimeout(() => {
			checkAndNotifyMorningDigest(allEvents, starredIds, cityKey);
		}, delay);
	}
}

/**
 * Synchronizes all starred events into IndexedDB and re-arms notifications.
 */
export async function syncAllStarredEvents(
	events: Event[],
	starredIds: Set<string>,
	cityKey: string,
): Promise<void> {
	for (const ev of events) {
		const id = eventId(ev);
		if (starredIds.has(id)) {
			await schedule1hReminder(ev, cityKey, false);
		}
	}
	await checkAndNotifyMorningDigest(events, starredIds, cityKey);
}

/**
 * Sends a test notification to verify delivery on device.
 */
export async function sendTestNotification(): Promise<void> {
	if (!canUseNotifications()) return;
	if (Notification.permission !== "granted") {
		const perm = await requestNotificationPermission();
		if (perm !== "granted") return;
	}

	const reg = await getSwRegistration();
	if (reg) {
		await reg.showNotification("Notifications Active", {
			body: "You'll receive a reminder 1 hour before bookmarked events and a morning digest at 8am.",
			icon: "/icons/icon-192.png",
			badge: "/icons/icon-192.png",
			tag: "test-notification",
			data: { url: "/#starred-section" },
		});
	} else {
		new Notification("Notifications Active", {
			body: "You'll receive a reminder 1 hour before bookmarked events and a morning digest at 8am.",
			icon: "/icons/icon-192.png",
			tag: "test-notification",
		});
	}
}
