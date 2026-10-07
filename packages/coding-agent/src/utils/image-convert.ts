import { getCapabilities, type ImageTranscoder, setImageTranscoder } from "@earendil-works/pi-tui";
import { decodeImageBase64 } from "./image-admission.ts";
import { resizeImage } from "./image-resize.ts";

export async function convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	// Conversion uses the same bounded worker as resizing; no decoder on the UI thread.
	let mimeType: string;
	if (bytes[0] === 255 && bytes[1] === 216) mimeType = "image/jpeg";
	else if (bytes[0] === 137 && bytes[1] === 80) mimeType = "image/png";
	else if (String.fromCharCode(...bytes.subarray(0, 3)) === "GIF") mimeType = "image/gif";
	else if (String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF") mimeType = "image/webp";
	else throw new Error("Unsupported image conversion format");
	const result = await resizeImage(bytes, mimeType, { outputCodecs: ["png"], forceReencode: true });
	return result ? Buffer.from(result.data, "base64") : null;
}
export async function convertToPng(
	base64Data: string,
	mimeType: string,
	signal?: AbortSignal,
): Promise<{ data: string; mimeType: string } | null> {
	const result = await resizeImage(decodeImageBase64(base64Data), mimeType, {
		maxWidth: 320,
		maxHeight: 320,
		maxBytes: 96 * 1024,
		outputCodecs: ["png"],
		forceReencode: true,
		signal,
	});
	return result ? { data: result.data, mimeType: result.mimeType } : null;
}
/** Public transcoder is async so legacy extension Image use cannot block render. */
export async function loadPngTranscoder(): Promise<ImageTranscoder> {
	return convertToPngData;
}
async function convertToPngData(data: string, mime: string, signal?: AbortSignal): Promise<string | null> {
	return (await convertToPng(data, mime, signal))?.data ?? null;
}
let registered = false;
export function ensurePngTranscoder(onRegistered: () => void): void {
	if (registered || getCapabilities().images !== "kitty") return;
	setImageTranscoder(convertToPngData);
	registered = true;
	onRegistered();
}
