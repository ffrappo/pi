import { applyExifOrientation } from "./exif-orientation.ts";
import { inspectImage } from "./image-admission.ts";
import { loadPhoton } from "./photon.ts";

export interface ImageResizeOptions {
	maxWidth?: number;
	maxHeight?: number;
	/** Base64 payload bytes, not raw encoded file bytes. */
	maxBytes?: number;
	jpegQuality?: number;
	outputCodecs?: Array<"png" | "jpeg">;
	forceReencode?: boolean;
	/** Conservative source/intermediate decode estimate. Default 64 MiB. */
	crop?: { x: number; y: number; width: number; height: number };
	maxDecodedBytes?: number;
}
export interface ResizedImage {
	data: string;
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
	crop?: { x: number; y: number; width: number; height: number };
}

/** Worker-only codec implementation. Failure never transports the original. */
export async function resizeImageInProcess(
	inputBytes: Uint8Array,
	mimeType: string,
	options: ImageResizeOptions = {},
): Promise<ResizedImage | null> {
	const maxWidth = options.maxWidth ?? 2000;
	const maxHeight = options.maxHeight ?? 2000;
	const maxBytes = options.maxBytes ?? 4.5 * 1024 * 1024;
	const maxDecodedBytes = options.maxDecodedBytes ?? 64 * 1024 * 1024;
	const quality = options.jpegQuality ?? 80;
	for (const value of [maxWidth, maxHeight, maxBytes, maxDecodedBytes]) {
		if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid image resize bound");
	}
	if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error("Invalid JPEG quality");
	const codecs = options.outputCodecs ?? ["png", "jpeg"];
	if (!codecs.length || codecs.some((c) => c !== "png" && c !== "jpeg"))
		throw new Error("Invalid image output codecs");
	const geometry = inspectImage(inputBytes, mimeType);
	if (geometry.width * geometry.height * 16 > maxDecodedBytes)
		throw new Error(
			`Image decode estimate ${geometry.width * geometry.height * 16} exceeds ${maxDecodedBytes} bytes`,
		);
	const photon = await loadPhoton();
	if (!photon) throw new Error("Photon image worker decoder unavailable");
	let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
	try {
		const raw = photon.PhotonImage.new_from_byteslice(inputBytes);
		try {
			image = applyExifOrientation(photon, raw, inputBytes);
		} catch (error) {
			raw.free();
			throw error;
		}
		if (image !== raw) raw.free();
		const originalWidth = image.get_width();
		const originalHeight = image.get_height();
		const crop = options.crop;
		if (crop) {
			if (
				![crop.x, crop.y, crop.width, crop.height].every(Number.isSafeInteger) ||
				crop.x < 0 ||
				crop.y < 0 ||
				crop.width <= 0 ||
				crop.height <= 0 ||
				crop.x + crop.width > originalWidth ||
				crop.y + crop.height > originalHeight
			)
				throw new Error("Image crop is outside oriented original coordinates");
			const cropped = photon.crop(image, crop.x, crop.y, crop.x + crop.width, crop.y + crop.height);
			image.free();
			image = cropped;
		}
		const sourceWidth = image.get_width(),
			sourceHeight = image.get_height();
		const pixels = image.get_raw_pixels();
		let alpha = false;
		for (let i = 3; i < pixels.length; i += 4) {
			if (pixels[i] !== 255) {
				alpha = true;
				break;
			}
		}
		const allowed = codecs.filter((codec) => codec !== "jpeg" || !alpha);
		if (!allowed.length) throw new Error("Requested image codec cannot preserve transparency");
		const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
		let width = Math.max(1, Math.floor(sourceWidth * scale));
		let height = Math.max(1, Math.floor(sourceHeight * scale));
		while (true) {
			const resized = photon.resize(image, width, height, photon.SamplingFilter.Lanczos3);
			try {
				const candidates: Array<{ data: string; mimeType: string }> = [];
				const add = (bytes: Uint8Array, mimeType: string) => {
					const data = Buffer.from(bytes).toString("base64");
					if (data.length <= maxBytes) candidates.push({ data, mimeType });
				};
				if (allowed.includes("png")) add(resized.get_bytes(), "image/png");
				if (allowed.includes("jpeg")) add(resized.get_bytes_jpeg(quality), "image/jpeg");
				// Lower quality only if no preferred-quality admissible encoding fits.
				if (!candidates.length && allowed.includes("jpeg")) {
					for (const q of [70, 55, 40].filter((q) => q < quality)) {
						add(resized.get_bytes_jpeg(q), "image/jpeg");
						if (candidates.length) break;
					}
				}
				candidates.sort((a, b) => a.data.length - b.data.length);
				const best = candidates[0];
				if (best)
					return {
						...best,
						originalWidth,
						originalHeight,
						width,
						height,
						wasResized: width !== originalWidth || height !== originalHeight,
						...(crop ? { crop } : {}),
					};
			} finally {
				resized.free();
			}
			if (width === 1 && height === 1) return null;
			width = Math.max(1, Math.floor(width * 0.75));
			height = Math.max(1, Math.floor(height * 0.75));
		}
	} finally {
		image?.free();
	}
}
