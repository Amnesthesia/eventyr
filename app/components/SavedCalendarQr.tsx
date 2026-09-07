// The QR code for a saved-events link, drawn as one inline SVG path.
//
// A path built from the dark modules rather than 1,600 <rect> elements or the
// library's own createSvgTag: the path keeps the DOM small, and building it
// ourselves means the colour comes from a CSS variable and follows the site's
// theme instead of being a baked-in black.
import qrcode from "qrcode-generator";

interface Props {
	url: string;
	size?: number;
}

/** Quiet zone, in modules. The spec's minimum is 4, and scanners genuinely
 * fail without it against a busy background. */
const MARGIN = 4;

export default function SavedCalendarQr({ url, size = 200 }: Props) {
	// Type 0 = pick the smallest version that fits. "M" corrects ~15%, which is
	// the usual choice for a code read off a screen rather than off paper.
	const qr = qrcode(0, "M");
	qr.addData(url);
	qr.make();

	const count = qr.getModuleCount();
	const extent = count + MARGIN * 2;
	const path: string[] = [];
	for (let row = 0; row < count; row++) {
		for (let col = 0; col < count; col++) {
			if (qr.isDark(row, col)) {
				path.push(`M${col + MARGIN} ${row + MARGIN}h1v1h-1z`);
			}
		}
	}

	return (
		<svg
			className="saved-qr"
			width={size}
			height={size}
			viewBox={`0 0 ${extent} ${extent}`}
			role="img"
			aria-label="QR code linking to these saved events"
		>
			<title>Scan to open these saved events</title>
			{/* The light modules have to be painted, not left transparent: a
			    scanner needs the contrast, and in dark mode the page behind is
			    nearly the same value as the code. */}
			<rect width={extent} height={extent} fill="#fff" />
			<path d={path.join("")} fill="#000" />
		</svg>
	);
}
