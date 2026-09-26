// Long-press detection, touch only.
//
// Deliberately not bound to mouse events: a desktop right-click already has a
// menu people rely on ("open link in new tab"), and replacing it would be
// hostile. This is the mobile gesture only.
import { useCallback, useEffect, useRef } from "react";

/** Long enough not to fire on a slow tap, short enough not to feel broken.
 * iOS's own callout is ~500ms, so matching it keeps the gesture familiar. */
const HOLD_MS = 500;
/** A press that drifts further than this is a scroll, not a hold. */
const MOVE_TOLERANCE_PX = 10;

export function useLongPress(onLongPress: () => void) {
	const timer = useRef<number | null>(null);
	const origin = useRef<{ x: number; y: number } | null>(null);
	const fired = useRef(false);

	const cancel = useCallback(() => {
		if (timer.current !== null) {
			window.clearTimeout(timer.current);
			timer.current = null;
		}
		origin.current = null;
	}, []);

	// A press interrupted by unmount must not leave a timer that fires into a
	// gone component.
	useEffect(() => cancel, [cancel]);

	return {
		onTouchStart: (e: React.TouchEvent) => {
			const touch = e.touches[0];
			if (!touch) return;
			fired.current = false;
			origin.current = { x: touch.clientX, y: touch.clientY };
			timer.current = window.setTimeout(() => {
				fired.current = true;
				// A short buzz is the confirmation a native long-press gives, and
				// without it the sheet appears to come from nowhere.
				navigator.vibrate?.(10);
				onLongPress();
			}, HOLD_MS);
		},
		onTouchMove: (e: React.TouchEvent) => {
			const touch = e.touches[0];
			if (!touch || !origin.current) return;
			const moved =
				Math.abs(touch.clientX - origin.current.x) > MOVE_TOLERANCE_PX ||
				Math.abs(touch.clientY - origin.current.y) > MOVE_TOLERANCE_PX;
			if (moved) cancel();
		},
		onTouchEnd: (e: React.TouchEvent) => {
			cancel();
			// The hold already opened the sheet, so the finger lifting must not
			// also follow the card's link.
			if (fired.current) e.preventDefault();
		},
		onTouchCancel: cancel,
		onContextMenu: (e: React.MouseEvent) => {
			// Android fires contextmenu at the end of a long press; letting it
			// through would stack the browser's menu on top of ours.
			if (fired.current) e.preventDefault();
		},
	};
}
