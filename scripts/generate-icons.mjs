import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";

function createPng(width, height, drawFn) {
	// 8-byte PNG signature
	const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

	function createChunk(type, data) {
		const typeBuf = Buffer.from(type, "ascii");
		const lenBuf = Buffer.alloc(4);
		lenBuf.writeUInt32BE(data.length, 0);

		const crcBuf = Buffer.alloc(4);
		const crcData = Buffer.concat([typeBuf, data]);
		const crc = zlib.crc32(crcData);
		crcBuf.writeUInt32BE(crc >>> 0, 0);

		return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
	}

	// IHDR
	const ihdrData = Buffer.alloc(13);
	ihdrData.writeUInt32BE(width, 0);
	ihdrData.writeUInt32BE(height, 4);
	ihdrData.writeUInt8(8, 8); // bit depth: 8
	ihdrData.writeUInt8(6, 9); // color type: 6 (RGBA)
	ihdrData.writeUInt8(0, 10); // compression: 0 (deflate)
	ihdrData.writeUInt8(0, 11); // filter: 0
	ihdrData.writeUInt8(0, 12); // interlace: 0
	const ihdrChunk = createChunk("IHDR", ihdrData);

	// Raw pixel data: each scanline starts with a filter byte (0)
	const rowBytes = 1 + width * 4;
	const rawData = Buffer.alloc(height * rowBytes);

	for (let y = 0; y < height; y++) {
		const rowOffset = y * rowBytes;
		rawData[rowOffset] = 0; // Filter None
		for (let x = 0; x < width; x++) {
			const [r, g, b, a] = drawFn(x, y, width, height);
			const pixelOffset = rowOffset + 1 + x * 4;
			rawData[pixelOffset] = r;
			rawData[pixelOffset + 1] = g;
			rawData[pixelOffset + 2] = b;
			rawData[pixelOffset + 3] = a;
		}
	}

	const idatData = zlib.deflateSync(rawData, { level: 9 });
	const idatChunk = createChunk("IDAT", idatData);
	const iendChunk = createChunk("IEND", Buffer.alloc(0));

	return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// Draw chevron `>` on dark background
function drawChevronIcon(x, y, width, height, isMaskable = false) {
	// Background: dark #0b0b0b
	const bgR = 11;
	const bgG = 11;
	const bgB = 11;

	// Scale coordinates to normalized [0, 1]
	const nx = x / width;
	const ny = y / height;

	// Scale chevron size depending on maskable safe area
	const scale = isMaskable ? 0.48 : 0.62;
	const cx = 0.48;
	const cy = 0.5;

	// Map to chevron coordinate system
	const px = (nx - cx) / scale;
	const py = (ny - cy) / scale;

	const thickness = 0.13;

	// Distance from point to line segment
	function distToSegment(px, py, x1, y1, x2, y2) {
		const dx = x2 - x1;
		const dy = y2 - y1;
		const lenSq = dx * dx + dy * dy;
		const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
		const projX = x1 + t * dx;
		const projY = y1 + t * dy;
		return Math.hypot(px - projX, py - projY);
	}

	const d1 = distToSegment(px, py, -0.32, -0.5, 0.32, 0);
	const d2 = distToSegment(px, py, 0.32, 0, -0.32, 0.5);
	const d = Math.min(d1, d2);

	// Anti-aliasing width in normalized chevron units
	const pixelSize = (1 / width) / scale;
	const edge = thickness;
	const alpha = Math.max(0, Math.min(1, (edge + pixelSize - d) / (pixelSize * 1.5)));

	if (alpha <= 0) {
		return [bgR, bgG, bgB, 255];
	}

	const fgR = 248;
	const fgG = 248;
	const fgB = 248;

	const r = Math.round(bgR * (1 - alpha) + fgR * alpha);
	const g = Math.round(bgG * (1 - alpha) + fgG * alpha);
	const b = Math.round(bgB * (1 - alpha) + fgB * alpha);

	return [r, g, b, 255];
}

const iconsDir = join(process.cwd(), "public", "icons");
mkdirSync(iconsDir, { recursive: true });

// 1. icon-192.png
const png192 = createPng(192, 192, (x, y, w, h) => drawChevronIcon(x, y, w, h, false));
writeFileSync(join(iconsDir, "icon-192.png"), png192);

// 2. icon-512.png
const png512 = createPng(512, 512, (x, y, w, h) => drawChevronIcon(x, y, w, h, false));
writeFileSync(join(iconsDir, "icon-512.png"), png512);

// 3. icon-maskable-512.png
const pngMaskable512 = createPng(512, 512, (x, y, w, h) => drawChevronIcon(x, y, w, h, true));
writeFileSync(join(iconsDir, "icon-maskable-512.png"), pngMaskable512);

// 4. apple-touch-icon.png (180x180)
const pngApple180 = createPng(180, 180, (x, y, w, h) => drawChevronIcon(x, y, w, h, false));
writeFileSync(join(iconsDir, "apple-touch-icon.png"), pngApple180);

// 5. SVG icon
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="#0b0b0b" />
  <path d="M 160 110 L 350 256 L 160 402" fill="none" stroke="#f8f8f8" stroke-width="64" stroke-linecap="round" stroke-linejoin="round" />
</svg>
`;
writeFileSync(join(iconsDir, "icon.svg"), svg);

console.log("✓ Generated PWA icons in public/icons/");

