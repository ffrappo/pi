import type { Api, Model } from "@earendil-works/pi-ai";

interface Images {
	count: number;
	bytes: number;
}
function imagePayload(value: unknown): Images {
	if (!value || typeof value !== "object") return { count: 0, bytes: 0 };
	if (Array.isArray(value)) {
		return value.reduce<Images>(
			(total, item) => {
				const image = imagePayload(item);
				return { count: total.count + image.count, bytes: total.bytes + image.bytes };
			},
			{ count: 0, bytes: 0 },
		);
	}
	const block = value as Record<string, unknown>;
	// Provider-owned image blocks, not arbitrary data URLs mentioned in text.
	if (block.type === "image_url" || block.type === "input_image") {
		const image = block.image_url;
		const url =
			typeof image === "string"
				? image
				: image && typeof image === "object" && "url" in image
					? image.url
					: undefined;
		if (typeof url !== "string") throw new Error("Serialized image URL is missing");
		if (!url.startsWith("data:image/")) throw new Error("Unbound remote image URL reached native media admission");
		const comma = url.indexOf(",");
		if (comma < 0 || !url.slice(0, comma).endsWith(";base64")) throw new Error("Invalid serialized image data URL");
		return { count: 1, bytes: url.length - comma - 1 };
	}
	const mime = block.media_type ?? block.mimeType ?? block.mime_type;
	if (typeof mime === "string" && mime.startsWith("image/") && typeof block.data === "string") {
		return { count: 1, bytes: block.data.length };
	}
	let count = 0,
		bytes = 0;
	for (const [key, item] of Object.entries(block)) {
		if (key === "text" || key === "data") continue;
		const image = imagePayload(item);
		count += image.count;
		bytes += image.bytes;
	}
	return { count, bytes };
}

/** Runs after all payload transforms, immediately before the provider sends. */
export function admitMediaPayload(payload: unknown, model: Model<Api>): void {
	const json = JSON.stringify(payload);
	if (json === undefined) throw new Error("Provider payload is not serializable");
	const limits = model.inputLimits?.images;
	const size = Buffer.byteLength(json, "utf8");
	if (model.inputLimits?.maxRequestBytes && size > model.inputLimits.maxRequestBytes) {
		throw new Error(
			`Provider request ${size} bytes exceeds ${model.inputLimits.maxRequestBytes} for ${model.provider}/${model.id}`,
		);
	}
	const total = imagePayload(payload);
	if (total.count > Math.min(16, limits?.maxPerRequest ?? 16) || total.bytes > 16 * 1024 * 1024) {
		throw new Error(`Serialized media exceeds budget: ${total.count} images, ${total.bytes} encoded bytes`);
	}
	if (payload && typeof payload === "object") {
		const object = payload as Record<string, unknown>;
		const messages = object.messages ?? object.contents ?? object.input;
		if (Array.isArray(messages)) {
			for (const message of messages) {
				const images = imagePayload(message);
				if (images.count > Math.min(16, limits?.maxPerMessage ?? 16)) {
					throw new Error(`Serialized message media count ${images.count} exceeds ${limits?.maxPerMessage ?? 16}`);
				}
			}
		}
	}
}
