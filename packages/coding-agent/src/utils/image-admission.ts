import { Buffer } from "node:buffer";

/** Inspect container headers before allocating a decoder. Never guesses geometry. */
export function inspectImage(bytes: Uint8Array, mimeType: string): { width: number; height: number } {
	const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let width = 0,
		height = 0;
	switch (mimeType) {
		case "image/png":
			if (
				b.length < 33 ||
				b.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
				b.toString("ascii", 12, 16) !== "IHDR"
			)
				break;
			width = b.readUInt32BE(16);
			height = b.readUInt32BE(20);
			break;
		case "image/jpeg": {
			if (b.length < 4 || b[0] !== 255 || b[1] !== 216) break;
			let p = 2;
			while (p + 4 <= b.length) {
				if (b[p++] !== 255) throw new Error("Invalid JPEG marker");
				while (b[p] === 255) p++;
				const marker = b[p++];
				if (marker === 217 || marker === 218) break;
				if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
				if (p + 2 > b.length) break;
				const size = b.readUInt16BE(p);
				if (size < 2 || p + size > b.length) throw new Error("Truncated JPEG segment");
				if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
					if (size < 8) throw new Error("Invalid JPEG geometry");
					height = b.readUInt16BE(p + 3);
					width = b.readUInt16BE(p + 5);
					break;
				}
				p += size;
			}
			break;
		}
		case "image/gif":
			if (b.length < 13 || !["GIF87a", "GIF89a"].includes(b.toString("ascii", 0, 6))) break;
			width = b.readUInt16LE(6);
			height = b.readUInt16LE(8);
			break;
		case "image/webp": {
			if (
				b.length < 25 ||
				b.toString("ascii", 0, 4) !== "RIFF" ||
				b.toString("ascii", 8, 12) !== "WEBP" ||
				b.readUInt32LE(4) + 8 !== b.length
			)
				break;
			const chunk = b.toString("ascii", 12, 16);
			if (chunk === "VP8X" && b.length >= 30) {
				width = b.readUIntLE(24, 3) + 1;
				height = b.readUIntLE(27, 3) + 1;
			} else if (chunk === "VP8L" && b[20] === 47) {
				const bits = b.readUInt32LE(21);
				width = (bits & 16383) + 1;
				height = ((bits >>> 14) & 16383) + 1;
			} else if (chunk === "VP8 " && b.length >= 30 && b.toString("hex", 23, 26) === "9d012a") {
				width = b.readUInt16LE(26) & 16383;
				height = b.readUInt16LE(28) & 16383;
			}
			break;
		}
		default:
			throw new Error(`Unsupported image decoder: ${mimeType}`);
	}
	if (!Number.isSafeInteger(width * height * 16) || width <= 0 || height <= 0)
		throw new Error(`Invalid or mismatched ${mimeType} geometry`);
	return { width, height };
}

export function decodeImageBase64(data: string): Uint8Array {
	if (
		!data.length ||
		data.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
	)
		throw new Error("Invalid image base64");
	const bytes = Buffer.from(data, "base64");
	if (bytes.toString("base64") !== data) throw new Error("Non-canonical image base64");
	return bytes;
}
