import { Bell, BellOff, BellRing, Check, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { useEventsContext } from "../context";
import {
	canUseNotifications,
	getNotificationPermission,
	isMobilePhone,
	isStandalone,
	requestNotificationPermission,
	sendTestNotification,
	syncAllStarredEvents,
} from "../utils/notifications";

export default function NotificationPrompt() {
	const { cityData, starred, cityKey } = useEventsContext();
	const [supported, setSupported] = useState(false);
	const [permission, setPermission] =
		useState<NotificationPermission>("default");
	// null = idle. The outcome matters: on a browser that quietly declines to
	// show anything (Safari on macOS only delivers these to an installed web
	// app) this used to confirm a notification the reader never saw.
	const [testResult, setTestResult] = useState<"sent" | "failed" | null>(null);
	const [showMenu, setShowMenu] = useState(false);

	useEffect(() => {
		setSupported(canUseNotifications());
		setPermission(getNotificationPermission());
	}, []);

	if (!supported) return null;

	const standalone = isStandalone();
	const mobile = isMobilePhone();

	async function handleEnable() {
		const newPerm = await requestNotificationPermission();
		setPermission(newPerm);
		if (newPerm === "granted") {
			await syncAllStarredEvents(cityData.events, starred, cityKey);
			setShowMenu(true);
		}
	}

	async function handleTest() {
		const shown = await sendTestNotification();
		setTestResult(shown ? "sent" : "failed");
		setTimeout(() => setTestResult(null), shown ? 2000 : 6000);
	}

	return (
		<div className="notif-prompt-container">
			{permission === "granted" ? (
				<button
					type="button"
					className="filter-btn notif-on"
					onClick={() => setShowMenu((prev) => !prev)}
					title="Notification reminders active (1h before & 8am digest)"
					aria-label="Notification settings"
					aria-expanded={showMenu}
				>
					<BellRing size={12} strokeWidth={2.2} />
					<span>Reminders on</span>
				</button>
			) : permission === "denied" ? (
				<button
					type="button"
					className="filter-btn notif-blocked"
					disabled
					title="Notifications blocked in browser settings"
					aria-label="Notifications blocked"
				>
					<BellOff size={12} strokeWidth={2.2} />
					<span>Reminders blocked</span>
				</button>
			) : (
				<button
					type="button"
					className="filter-btn"
					onClick={handleEnable}
					title="Get reminders 1h before events and at 8am"
					aria-label="Enable event notification reminders"
				>
					<Bell size={12} strokeWidth={2.2} />
					<span>Get reminders</span>
				</button>
			)}

			{showMenu && permission === "granted" && (
				<div className="notif-popover" role="dialog" aria-label="Reminders">
					<div className="notif-popover-header">
						<strong>Event Reminders Active</strong>
						<button
							type="button"
							className="notif-close"
							onClick={() => setShowMenu(false)}
							aria-label="Close"
						>
							&times;
						</button>
					</div>
					<p className="notif-popover-desc">
						You will receive notifications:
						<br />
						&bull; <strong>1 hour before</strong> each bookmarked event starts
						<br />
						&bull; <strong>At 8:00 AM</strong> summarizing all bookmarked events
						for today
					</p>
					{mobile && !standalone && (
						<p className="notif-pwa-tip">
							Tip: Add this app to your Home Screen for the best standalone
							experience on your phone.
						</p>
					)}
					<button
						type="button"
						className="notif-test-btn"
						onClick={handleTest}
						disabled={testResult === "sent"}
					>
						{testResult === "sent" ? (
							<>
								<Check size={13} /> Sent!
							</>
						) : (
							<>
								<Send size={13} /> Send test notification
							</>
						)}
					</button>
					{testResult === "failed" && (
						<p className="notif-test-failed">
							Your browser didn't show it. Safari on macOS only delivers these
							to an installed web app — add this site to your Dock, or use
							Chrome.
						</p>
					)}
				</div>
			)}
		</div>
	);
}
