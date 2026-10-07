import type { Api, Model } from "@earendil-works/pi-ai";
/** Runs after all payload transforms, immediately before the provider sends. */
export function admitMediaPayload(payload: unknown, model: Model<Api>): void {
	const json = JSON.stringify(payload);
	const limits = model.inputLimits?.images;
	const size = Buffer.byteLength(json, "utf8");
	if (model.inputLimits?.maxRequestBytes && size > model.inputLimits.maxRequestBytes)
		throw new Error(
			`Provider request ${size} bytes exceeds ${model.inputLimits.maxRequestBytes} for ${model.provider}/${model.id}`,
		);
	let count = 0,
		bytes = 0;
	const visit = (value: unknown): void => {
		if (typeof value === "string") {
			if (value.startsWith("data:image/")) {
				const comma = value.indexOf(",");
				count++;
				bytes += value.length - comma - 1;
			}
			return;
		}
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		const object = value as Record<string, unknown>;
		if (
			object.type === "base64" &&
			typeof object.media_type === "string" &&
			object.media_type.startsWith("image/") &&
			typeof object.data === "string"
		) {
			count++;
			bytes += object.data.length;
		}
		if (
			typeof object.mimeType === "string" &&
			object.mimeType.startsWith("image/") &&
			typeof object.data === "string"
		) {
			count++;
			bytes += object.data.length;
		}
		for (const [key, item] of Object.entries(object)) if (key !== "data") visit(item);
	};
	visit(payload);
	if (count > Math.min(16, limits?.maxPerRequest ?? 16) || bytes > 16 * 1024 * 1024)
		throw new Error(`Serialized media exceeds budget: ${count} images, ${bytes} encoded bytes`);
}
