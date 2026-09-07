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
	const [testSent, setTestSent] = useState(false);
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
		await sendTestNotification();
		setTestSent(true);
		setTimeout(() => setTestSent(false), 2000);
	}

	return (
		<div className="notif-prompt-container">
			{permission === "granted" ? (
				<button
					type="button"
					className="notif-pill notif-active"
					onClick={() => setShowMenu((prev) => !prev)}
					title="Notification reminders active (1h before & 8am digest)"
					aria-label="Notification settings"
					aria-expanded={showMenu}
				>
					<BellRing size={13} strokeWidth={2.2} />
					<span>Reminders on</span>
				</button>
			) : permission === "denied" ? (
				<button
					type="button"
					className="notif-pill notif-disabled"
					disabled
					title="Notifications blocked in browser settings"
					aria-label="Notifications blocked"
				>
					<BellOff size={13} strokeWidth={2.2} />
					<span>Reminders blocked</span>
				</button>
			) : (
				<button
					type="button"
					className="notif-pill notif-enable"
					onClick={handleEnable}
					title="Get reminders 1h before events and at 8am"
					aria-label="Enable event notification reminders"
				>
					<Bell size={13} strokeWidth={2.2} />
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
						disabled={testSent}
					>
						{testSent ? (
							<>
								<Check size={13} /> Sent!
							</>
						) : (
							<>
								<Send size={13} /> Send test notification
							</>
						)}
					</button>
				</div>
			)}
		</div>
	);
}
