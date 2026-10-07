import { parentPort } from "node:worker_threads";
import { type ImageResizeOptions, type ResizedImage, resizeImageInProcess } from "./image-resize-core.ts";

interface ResizeImageWorkerRequest {
	id: number;
	inputBytes: Uint8Array;
	mimeType: string;
	options?: ImageResizeOptions;
}

interface ResizeImageWorkerResponse {
	id: number;
	result?: ResizedImage | null;
	error?: string;
}

function isResizeImageWorkerRequest(value: unknown): value is ResizeImageWorkerRequest {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		Number.isSafeInteger(record.id) && record.inputBytes instanceof Uint8Array && typeof record.mimeType === "string"
	);
}

const port = parentPort;
if (!port) {
	throw new Error("image resize worker requires parentPort");
}

port.on("message", (message: unknown) => {
	void (async () => {
		try {
			if (!isResizeImageWorkerRequest(message)) {
				throw new Error("Invalid image resize worker request");
			}
			const result = await resizeImageInProcess(message.inputBytes, message.mimeType, message.options);
			const response: ResizeImageWorkerResponse = { id: message.id, result };
			port.postMessage(response);
		} catch (error) {
			const response: ResizeImageWorkerResponse = {
				id: isResizeImageWorkerRequest(message) ? message.id : -1,
				error: error instanceof Error ? error.message : String(error),
			};
			port.postMessage(response);
		}
	})();
});
