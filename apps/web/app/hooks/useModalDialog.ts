import { useEffect, useRef } from "react";

/**
 * Opens a <dialog> as a real modal — showModal() gives it a native focus trap,
 * Escape-to-close, the top layer, and focus restored to whatever triggered it
 * on close, none of which three hand-rolled `role="dialog"` overlays had
 * (they set `aria-modal="true"` but nothing actually stopped Tab walking the
 * page behind them).
 *
 * Returns the ref to attach to the <dialog>, plus `close()` — callers should
 * always route "close this modal" through close() rather than calling the
 * onClose prop directly, so the native close-and-restore-focus sequence runs
 * before React unmounts it. onClose fires once, from the dialog's own `close`
 * event, however it was triggered: this close(), the scrim button routed
 * through it, or the browser's own Escape handling.
 */
export function useModalDialog(onClose: () => void) {
	const ref = useRef<HTMLDialogElement>(null);
	// Always the latest onClose, without re-running the effect (and thus
	// re-opening the dialog) whenever the caller passes a new closure.
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		dialog.showModal();
		const handleClose = () => onCloseRef.current();
		dialog.addEventListener("close", handleClose);
		return () => dialog.removeEventListener("close", handleClose);
	}, []);

	return { ref, close: () => ref.current?.close() };
}
