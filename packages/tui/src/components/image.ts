import { releaseImageBytes, reserveImageBytes } from "../image-budget.ts";
import {
	allocateImageId,
	getCapabilities,
	getCellDimensions,
	getImageDimensions,
	getPngDimensions,
	type ImageDimensions,
	imageFallback,
	renderImage,
} from "../terminal-image.ts";
import type { Component } from "../tui.ts";
import { truncateToWidth } from "../utils.ts";

/**
 * Converts base64 image data to base64 PNG data, or returns null if it cannot.
 * Called asynchronously after rendering; native conversion runs in a worker.
 */
export type ImageTranscoder = (
	base64Data: string,
	mimeType: string,
	signal?: AbortSignal,
) => string | null | Promise<string | null>;

let imageTranscoder: ImageTranscoder | undefined;
// Backstop for callers that recreate Image instances. Keyed by source data, least recently used first.
const pngCache = new Map<string, { data: string | null; owner: object }>();

/**
 * Register the converter used for non-PNG images on Kitty-protocol terminals, which only accept PNG.
 * Without one, such images render as text fallbacks.
 */
export function setImageTranscoder(transcoder: ImageTranscoder | undefined): void {
	imageTranscoder = transcoder;
	for (const entry of pngCache.values()) releaseImageBytes(entry.owner);
	pngCache.clear();
}

async function toPng(base64Data: string, mimeType: string, signal: AbortSignal): Promise<string | null> {
	if (!imageTranscoder) return null;
	const key = `${mimeType}:${base64Data}`;
	const cached = pngCache.get(key);
	if (cached) {
		pngCache.delete(key);
		pngCache.set(key, cached);
		return cached.data;
	}
	await Promise.resolve();
	const png = await imageTranscoder(base64Data, mimeType, signal);
	signal.throwIfAborted();
	const owner = {};
	reserveImageBytes(owner, (key.length + (png?.length ?? 0)) * 2, () => {
		pngCache.delete(key);
	});
	pngCache.set(key, { data: png, owner });
	while (pngCache.size > 32) {
		const oldest = pngCache.keys().next().value!;
		releaseImageBytes(pngCache.get(oldest)!.owner);
		pngCache.delete(oldest);
	}
	return png;
}

export interface ImageTheme {
	fallbackColor: (str: string) => string;
}

export interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
	/** Kitty image ID. If provided, reuses this ID (for animations/updates). */
	imageId?: number;
	/** TUI upload owner releases this exact image ID on dispose. */
	onDisposeImage?: (imageId: number) => void;
	onReady?: () => void;
}

export class Image implements Component {
	private base64Data: string;
	private mimeType: string;
	private dimensions: ImageDimensions;
	private theme: ImageTheme;
	private options: ImageOptions;
	private imageId?: number;
	/** Converted PNG data for Kitty. Failures are not stored so a later transcoder can retry. */
	private pngData?: string;
	private conversion = new AbortController();
	private conversionPending = false;
	private conversionError?: string;

	private disposed = false;
	private cachedLines?: string[];
	private cachedWidth?: number;

	constructor(
		base64Data: string,
		mimeType: string,
		theme: ImageTheme,
		options: ImageOptions = {},
		dimensions?: ImageDimensions,
	) {
		this.base64Data = base64Data;
		this.mimeType = mimeType;
		this.theme = theme;
		this.options = options;
		this.dimensions = dimensions || getImageDimensions(base64Data, mimeType)!;
		if (!this.dimensions || this.dimensions.widthPx <= 0 || this.dimensions.heightPx <= 0)
			throw new Error("Invalid image dimensions");
		reserveImageBytes(this, base64Data.length * 2);
		this.imageId = options.imageId;
	}

	/** Get the Kitty image ID used by this image (if any). */
	getImageId(): number | undefined {
		return this.imageId;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.conversion.abort();
		if (this.imageId !== undefined) this.options.onDisposeImage?.(this.imageId);
		this.base64Data = "";
		this.pngData = undefined;
		this.cachedLines = undefined;
		releaseImageBytes(this);
	}

	invalidate(): void {
		if (!this.disposed) reserveImageBytes(this, (this.base64Data.length + (this.pngData?.length ?? 0)) * 2);
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.disposed) return [];
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const maxWidth = Math.max(1, Math.min(width - 2, this.options.maxWidthCells ?? 60));
		const cellDimensions = getCellDimensions();
		const defaultMaxHeight = Math.max(1, Math.ceil((maxWidth * cellDimensions.widthPx) / cellDimensions.heightPx));
		const maxHeight = this.options.maxHeightCells ?? defaultMaxHeight;

		const caps = getCapabilities();
		let data: string | null = this.base64Data;
		let dimensions = this.dimensions;
		if (caps.images === "kitty" && this.mimeType !== "image/png") {
			if (!this.pngData && !this.conversionPending && !this.conversionError && imageTranscoder) {
				this.conversionPending = true;
				void toPng(this.base64Data, this.mimeType, this.conversion.signal)
					.then(
						(png) => {
							if (!this.disposed) {
								this.pngData = png ?? undefined;
								if (!png) this.conversionError = "PNG conversion unavailable";
								this.invalidate();
								this.options.onReady?.();
							}
						},
						(error) => {
							if (!this.disposed) {
								this.conversionError = String(error);
								this.invalidate();
								this.options.onReady?.();
							}
						},
					)
					.finally(() => {
						this.conversionPending = false;
					});
			}
			data = this.pngData ?? null;
			// Conversion may apply EXIF rotation, so prefer the PNG's own dimensions.
			if (data) dimensions = getPngDimensions(data) ?? dimensions;
		}
		let lines: string[];

		if (caps.images && data) {
			if (caps.images === "kitty" && this.imageId === undefined) {
				this.imageId = allocateImageId();
			}
			const result = renderImage(data, dimensions, {
				maxWidthCells: maxWidth,
				maxHeightCells: maxHeight,
				imageId: this.imageId,
				moveCursor: false,
			});

			if (result) {
				// Store the image ID for later cleanup
				if (result.imageId) {
					this.imageId = result.imageId;
				}

				if (caps.images === "kitty") {
					// For Kitty: C=1 prevents cursor movement.
					// Don't need the cursor movement.
					lines = [result.sequence];

					// Return `rows` lines so TUI accounts for image height.
					for (let i = 0; i < result.rows - 1; i++) {
						lines.push("");
					}
				} else {
					// Return `rows` lines so TUI accounts for image height.
					// First (rows-1) lines are empty and cleared before the image is drawn.
					// Last line: move cursor back up, draw the image, then move back down
					// so TUI cursor accounting stays inside the scroll area.
					lines = [];
					for (let i = 0; i < result.rows - 1; i++) {
						lines.push("");
					}
					const rowOffset = result.rows - 1;
					const moveUp = rowOffset > 0 ? `\x1b[${rowOffset}A` : "";
					lines.push(moveUp + result.sequence);
				}
			} else {
				const fallback = imageFallback(this.mimeType, this.dimensions, this.options.filename);
				lines = [truncateToWidth(this.theme.fallbackColor(fallback), width)];
			}
		} else {
			const fallback = this.conversionError ?? imageFallback(this.mimeType, this.dimensions, this.options.filename);
			lines = [truncateToWidth(this.theme.fallbackColor(fallback), width)];
		}

		reserveImageBytes(
			this,
			(this.base64Data.length + (this.pngData?.length ?? 0) + lines.reduce((n, line) => n + line.length, 0)) * 2,
		);
		this.cachedLines = lines;
		this.cachedWidth = width;

		return lines;
	}
}
