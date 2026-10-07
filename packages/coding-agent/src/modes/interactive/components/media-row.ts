import type { ImageContent } from "@earendil-works/pi-ai";
import {
	type Component,
	getCapabilities,
	Image,
	type TUI,
	type TuiMouseEvent,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { MediaAsset, MediaHandle, MediaPreviewLease, MediaReferenceContent } from "../../../core/media/types.ts";
import { decodeImageBase64 } from "../../../utils/image-admission.ts";
import { resizeImage } from "../../../utils/image-resize.ts";
import { theme } from "../theme/theme.ts";

export interface LegacyVideoSource {
	type: "legacy_video";
	path: string;
	poster?: ImageContent;
}
export type MediaRowSource = ImageContent | MediaReferenceContent | LegacyVideoSource;
export interface MediaRowOptions {
	ui: TUI;
	media?: MediaHandle;
	showImages?: boolean;
}
/** A metadata row owns no decoder until explicitly selected and visible. */
export class MediaRow implements Component {
	readonly source: MediaRowSource;
	private resolvedReference?: MediaReferenceContent;
	private finished = false;
	private registration?: Promise<MediaReferenceContent>;
	private options: MediaRowOptions;
	private asset?: MediaAsset;
	private expanded = false;
	private selected = false;
	private visible = false;
	private disposed = false;
	private error?: string;
	private image?: Image;
	private controller?: AbortController;
	private metadata = new AbortController();
	private lease?: MediaPreviewLease;
	private pending = false;
	private generation = 0;
	constructor(source: MediaRowSource, options: MediaRowOptions) {
		this.source = source;
		this.options = options;
		if (source.type === "media_reference" && options.media) {
			void options.media.describe(source, this.metadata.signal).then(
				(asset) => {
					if (!this.disposed) {
						this.asset = asset;
						options.ui.requestRender();
					}
				},
				(error) => {
					if (!this.disposed) {
						this.error = String(error);
						options.ui.requestRender();
					}
				},
			);
		}
	}
	createView(): MediaRow {
		return new MediaRow(this.source, this.options);
	}

	get label(): string {
		if (this.source.type === "legacy_video")
			return `video ${this.source.path.split(/[\\/]/).pop() ?? "Stored video"}`;
		if (this.source.type === "image")
			return `Stored image ${Math.ceil((this.source.data.length * 3) / 4 / 1024)} KiB`;
		const short = this.source.assetId.slice(7, 15);
		const size = this.asset ? `${Math.ceil(this.asset.byteSize / 1024)} KiB` : "";
		const duration = this.asset?.durationSeconds === undefined ? "" : `${this.asset.durationSeconds.toFixed(1)}s`;
		const scope =
			this.resolvedReference?.inspectionId ??
			(this.source.type === "media_reference" ? this.source.inspectionId : undefined);
		const metadata = this.asset?.metadataError ? "Metadata unavailable" : "";
		return `${this.source.kind} ${short} ${size} ${duration} ${this.asset?.availability === "missing" ? "Missing" : ""} ${metadata} ${scope ? (this.finished ? "Finished" : `Inspecting ${scope}`) : ""}`.trim();
	}
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		if (!expanded) {
			this.selected = false;
			this.release();
		}
		this.options.ui.requestRender();
	}
	select(): void {
		this.selected = true;
		this.expanded = true;
		this.prepare();
		this.options.ui.requestRender();
	}
	setVisible(visible: boolean): void {
		if (visible === this.visible) return;
		this.visible = visible;
		if (!visible) this.release();
		else this.prepare();
	}
	setViewport(start: number, end: number): void {
		this.setVisible(end > 0 && start < this.renderHeight());
	}
	private renderHeight(): number {
		return this.render(this.options.ui.terminal.columns).length;
	}
	setShowImages(show: boolean): void {
		this.options.showImages = show;
		if (!show) this.release();
		else this.prepare();
	}
	private release(): void {
		++this.generation;
		this.controller?.abort();
		this.controller = undefined;
		this.pending = false;
		this.image?.dispose();
		this.image = undefined;
		const lease = this.lease;
		this.lease = undefined;
		if (lease)
			void Promise.resolve(lease.release()).catch((error) => {
				this.error = `Preview release: ${String(error)}`;
				this.options.ui.requestRender();
			});
	}
	private async reference(signal?: AbortSignal): Promise<MediaReferenceContent> {
		if (this.resolvedReference) return this.resolvedReference;
		if (this.source.type === "media_reference") return this.source;
		if (this.source.type !== "legacy_video" || !this.options.media)
			throw new Error("Stored image original unavailable; import the session to register its stored derivative");
		this.registration ??= this.options.media.capture(
			{ source: "path", path: this.source.path, ingress: "legacy-cavallo", intent: "view" },
			signal,
		);
		this.resolvedReference = await this.registration;
		this.asset = await this.options.media.describe(this.resolvedReference, signal);
		return this.resolvedReference;
	}

	private prepare(): void {
		if (
			this.disposed ||
			!this.selected ||
			!this.visible ||
			!this.expanded ||
			this.pending ||
			this.image ||
			this.error ||
			this.options.showImages === false ||
			!getCapabilities().images
		)
			return;
		const controller = new AbortController();
		this.controller = controller;
		const token = ++this.generation;
		this.pending = true;
		void (async () => {
			let lease: MediaPreviewLease | undefined;
			try {
				let image: ImageContent;
				let width: number, height: number;
				if (this.source.type !== "image") {
					if (!this.options.media) throw new Error("Media service unavailable");
					const ref = await this.reference(controller.signal);
					lease = await this.options.media.preview(ref, {
						signal: controller.signal,
						codec: getCapabilities().images === "kitty" ? "png" : "jpeg",
						maxDimension: 320,
						maxEncodedBytes: 96 * 1024,
					});
					image = lease.image;
					width = lease.derivative.width;
					height = lease.derivative.height;
				} else {
					const result = await resizeImage(decodeImageBase64(this.source.data), this.source.mimeType, {
						maxWidth: 320,
						maxHeight: 320,
						maxBytes: 96 * 1024,
						outputCodecs: getCapabilities().images === "kitty" ? ["png"] : ["png", "jpeg"],
						signal: controller.signal,
						forceReencode: true,
					});
					if (!result) throw new Error("Stored image cannot fit preview limits");
					image = { type: "image", data: result.data, mimeType: result.mimeType };
					width = result.width;
					height = result.height;
				}
				if (controller.signal.aborted || token !== this.generation || this.disposed) {
					await lease?.release();
					return;
				}
				if (
					width > 320 ||
					height > 320 ||
					image.data.length > 96 * 1024 ||
					(getCapabilities().images === "kitty" && image.mimeType !== "image/png")
				)
					throw new Error("Media service returned an unbounded preview");
				this.image = new Image(
					image.data,
					image.mimeType,
					{ fallbackColor: (text) => theme.fg("muted", text) },
					{ maxWidthCells: 36, maxHeightCells: 10, onDisposeImage: (id) => this.options.ui.releaseImage(id) },
					{ widthPx: width, heightPx: height },
				);
				this.lease = lease;
			} catch (error) {
				if (error) {
					let cause = error;
					try {
						await lease?.release();
					} catch (releaseError) {
						cause = new Error(`${String(error)}; preview release failed: ${String(releaseError)}`);
					}
					if (!controller.signal.aborted && token === this.generation)
						this.error = cause instanceof Error ? cause.message : String(cause);
				}
			} finally {
				if (token === this.generation) {
					this.pending = false;
					this.options.ui.requestRender();
				}
			}
		})();
	}
	async action(action: "open" | "inspect" | "finish"): Promise<void> {
		try {
			if (!this.options.media) throw new Error("Media service unavailable");
			const ref = await this.reference();
			if (action === "open") await this.options.media.open(ref);
			else if (action === "inspect") {
				this.resolvedReference = await this.options.media.inspect(ref, { reason: "User selected Inspect" });
				this.finished = false;
			} else {
				if (!ref.inspectionId || this.finished) throw new Error("No active inspection on this row");
				await this.options.media.finish(ref.inspectionId, "User selected Finish");
				this.finished = true;
			}
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		}
		this.options.ui.requestRender();
	}
	handleMouse(event: TuiMouseEvent): { handled: boolean } | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (event.y === 0) {
			if (this.selected && this.expanded) this.setExpanded(false);
			else this.select();
		} else if (event.y === 1) void this.action(event.x < 7 ? "open" : event.x < 17 ? "inspect" : "finish");
		return { handled: true };
	}
	invalidate(): void {
		this.image?.invalidate();
	}
	render(width: number): string[] {
		const lines = [truncateToWidth(theme.fg("muted", `${this.expanded ? "▾" : "▸"} ${this.label}`), width)];
		if (!this.expanded) return lines;
		lines.push(truncateToWidth(theme.fg("accent", "Open   Inspect   Finish"), width));
		lines.push(
			truncateToWidth(
				theme.fg(
					"dim",
					this.source.type === "legacy_video"
						? this.source.path
						: this.source.type === "media_reference"
							? (this.asset?.canonicalPath ?? this.source.assetId)
							: "Persisted derivative; original unavailable",
				),
				width,
			),
		);
		if (this.asset?.metadataError) lines.push(truncateToWidth(theme.fg("warning", this.asset.metadataError), width));
		if (this.error) lines.push(truncateToWidth(theme.fg("error", this.error), width));
		else if (this.pending) lines.push(truncateToWidth(theme.fg("dim", "Preparing…"), width));
		if (
			(this.source.type === "legacy_video" ||
				(this.source.type === "media_reference" && this.source.kind === "video")) &&
			this.image
		)
			lines.push(truncateToWidth(theme.fg("dim", "Poster"), width));
		if (this.image) {
			try {
				lines.push(...this.image.render(width));
			} catch (error) {
				this.release();
				this.error = error instanceof Error ? error.message : String(error);
				lines.push(truncateToWidth(theme.fg("error", this.error), width));
			}
		}
		return lines;
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.metadata.abort();
		this.release();
	}
}
