import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { type ResizedImage, resizeImage } from "./image-resize.ts";
export interface ImagePreviewOptions {
	expectedDigest?: string;
	codec?: "png" | "jpeg";
	signal?: AbortSignal;
	maxDimension?: number;
	maxEncodedBytes?: number;
}
/** Read a verified local file boundedly; custody verification belongs to MediaHandle. */
export async function prepareImagePreview(path: string, options: ImagePreviewOptions = {}): Promise<ResizedImage> {
	const maxDimension = Math.min(320, options.maxDimension ?? 320);
	const maxEncodedBytes = Math.min(96 * 1024, options.maxEncodedBytes ?? 96 * 1024);
	options.signal?.throwIfAborted();
	const admitted = await lstat(path);
	if (!admitted.isFile()) throw new Error("Preview path is not a regular file");
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	let bytes: Buffer;
	try {
		const stat = await file.stat();
		if (stat.dev !== admitted.dev || stat.ino !== admitted.ino) throw new Error("Preview file changed before open");
		if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
			throw new Error("Inline preview requires a readable image <=32MiB; open the original instead");
		bytes = Buffer.alloc(stat.size);
		let offset = 0;
		while (offset < bytes.length) {
			options.signal?.throwIfAborted();
			const result = await file.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
			if (!result.bytesRead) throw new Error("Image changed during preview read");
			offset += result.bytesRead;
		}
		const after = await file.stat();
		if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
			throw new Error("Image changed during preview read");
	} finally {
		await file.close();
	}
	if (
		options.expectedDigest &&
		`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== options.expectedDigest
	)
		throw new Error("Preview original digest mismatch");
	let mimeType: string;
	if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") mimeType = "image/png";
	else if (bytes[0] === 255 && bytes[1] === 216) mimeType = "image/jpeg";
	else if (bytes.toString("ascii", 0, 3) === "GIF") mimeType = "image/gif";
	else if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
		mimeType = "image/webp";
	else throw new Error("Unsupported inline image preview format");
	const result = await resizeImage(bytes, mimeType, {
		maxWidth: maxDimension,
		maxHeight: maxDimension,
		maxBytes: maxEncodedBytes,
		outputCodecs: options.codec === "jpeg" ? ["png", "jpeg"] : ["png"],
		forceReencode: true,
		signal: options.signal,
	});
	if (!result) throw new Error("Image preview cannot fit the display byte bound");
	return result;
}
