import { Worker } from "node:worker_threads";
import type { ImageResizeOptions, ResizedImage } from "./image-resize-core.ts";

export type { ImageResizeOptions, ResizedImage } from "./image-resize-core.ts";

export interface ImageWorkerOptions extends ImageResizeOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}
interface Job {
	bytes: Uint8Array;
	mime: string;
	options: ImageResizeOptions;
	signal?: AbortSignal;
	timeout: number;
	resolve(value: ResizedImage | null): void;
	reject(error: Error): void;
	cancel(): void;
}
const waiting: Job[] = [];
let active: Job | undefined;
let worker: Worker | undefined;
let sequence = 0;

function pump(): void {
	if (active || !waiting.length) return;
	const job = waiting.shift()!;
	active = job;
	job.signal?.removeEventListener("abort", job.cancel);
	const id = ++sequence;
	try {
		worker ??= new Worker(
			typeof process.versions.bun === "string"
				? "./src/utils/image-resize-worker.ts"
				: new URL(
						import.meta.url.endsWith(".ts") ? "./image-resize-worker.ts" : "./image-resize-worker.js",
						import.meta.url,
					),
			{ execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")) },
		);
	} catch (error) {
		active = undefined;
		job.reject(error instanceof Error ? error : new Error(String(error)));
		pump();
		return;
	}
	const owned = worker;
	owned.ref();
	let settled = false;
	const finish = async (error?: Error, result?: ResizedImage | null) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		job.signal?.removeEventListener("abort", abort);
		owned.removeListener("message", message);
		owned.removeListener("error", failure);
		owned.removeListener("exit", exit);
		if (error) {
			worker = undefined;
			await owned.terminate();
		} else owned.unref();
		active = undefined;
		if (error) job.reject(error);
		else job.resolve(result ?? null);
		pump();
	};
	const abort = () => {
		void finish(new Error("Image resize cancelled"));
	};
	const failure = (error: Error) => {
		void finish(error);
	};
	const exit = (code: number) => {
		void finish(new Error(`Image resize worker exited ${code}`));
	};
	const message = (value: unknown) => {
		if (!value || typeof value !== "object") {
			failure(new Error("Invalid image worker response"));
			return;
		}
		const response = value as { id?: number; error?: string; result?: ResizedImage | null };
		if (response.id !== id) {
			failure(new Error("Mismatched image worker response"));
			return;
		}
		if (response.error) failure(new Error(response.error));
		else void finish(undefined, response.result);
	};
	const timer = setTimeout(() => {
		void finish(new Error(`Image resize timed out after ${job.timeout}ms`));
	}, job.timeout);
	owned.on("message", message);
	owned.once("error", failure);
	owned.once("exit", exit);
	job.signal?.addEventListener("abort", abort, { once: true });
	if (job.signal?.aborted) {
		abort();
		return;
	}
	const bytes = new Uint8Array(job.bytes);
	try {
		owned.postMessage({ id, inputBytes: bytes, mimeType: job.mime, options: job.options }, [bytes.buffer]);
	} catch (error) {
		failure(error instanceof Error ? error : new Error(String(error)));
	}
}

/** One reusable decoder, two waiting jobs, no main-thread decode fallback. */
export function resizeImage(
	inputBytes: Uint8Array,
	mimeType: string,
	options: ImageWorkerOptions = {},
): Promise<ResizedImage | null> {
	if (inputBytes.byteLength > 32 * 1024 * 1024) return Promise.reject(new Error("Image worker input exceeds 32MiB"));
	if (options.signal?.aborted) return Promise.reject(new Error("Image resize cancelled"));
	if (waiting.length >= 2) return Promise.reject(new Error("Image resize queue full (two waiting jobs)"));
	const { signal, timeoutMs = 10000, ...resizeOptions } = options;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error("Invalid image worker timeout"));
	return new Promise((resolve, reject) => {
		const job: Job = {
			bytes: inputBytes,
			mime: mimeType,
			options: resizeOptions,
			signal,
			timeout: timeoutMs,
			resolve,
			reject,
			cancel: () => {
				const index = waiting.indexOf(job);
				if (index !== -1) {
					waiting.splice(index, 1);
					signal?.removeEventListener("abort", job.cancel);
					reject(new Error("Image resize cancelled"));
				}
			},
		};
		waiting.push(job);
		signal?.addEventListener("abort", job.cancel, { once: true });
		pump();
	});
}
export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (result.crop)
		return `[Image crop: oriented original ${result.originalWidth}x${result.originalHeight}; region x=${result.crop.x}, y=${result.crop.y}, ${result.crop.width}x${result.crop.height}; displayed ${result.width}x${result.height}. Original x=${result.crop.x}+displayed x*${(result.crop.width / result.width).toFixed(4)}, y=${result.crop.y}+displayed y*${(result.crop.height / result.height).toFixed(4)}.]`;
	if (!result.wasResized) return undefined;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${(result.originalWidth / result.width).toFixed(2)} to map to original image.]`;
}
