import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { AgentContent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { prepareImagePreview } from "../../utils/image-preview.ts";
import type { SessionManager } from "../session-manager.ts";
import { repairMediaAdmission, unresolvedMedia } from "./admission.ts";
import { mediaReferences } from "./content.ts";
import { failedMedia, MediaAdmissionError, retainFailedMedia } from "./failures.ts";
import { MEDIA_POLICY_ENTRY, replayMediaPolicy } from "./policy.ts";
import {
	assertMediaReference,
	type InspectionLease,
	type InspectionRequest,
	MEDIA_CONTRACT,
	type MediaCaptureInput,
	type MediaHandle,
	type MediaOperationContext,
	type MediaPreviewOptions,
	type MediaReferenceContent,
	type MediaService,
} from "./types.ts";

export class SessionMedia implements MediaHandle {
	readonly capabilities = MEDIA_CONTRACT;
	get hasRequestLease(): boolean {
		return this.leases.length > 0 || this.controller !== undefined;
	}
	private service?: MediaService;
	private leases: InspectionLease[] = [];
	private epoch = 0;
	private controller?: AbortController;
	private isStreaming: () => boolean;
	private releasePending: Promise<void> = Promise.resolve();
	private manager: SessionManager;
	private invalidateRequest: () => void;
	private refresh: () => void;
	constructor(
		manager: SessionManager,
		invalidateRequest: () => void,
		refresh: () => void,
		isStreaming: () => boolean = () => false,
	) {
		this.manager = manager;
		this.invalidateRequest = invalidateRequest;
		this.refresh = refresh;
		this.isStreaming = isStreaming;
	}
	register(service: MediaService): () => void {
		if (service.contract !== MEDIA_CONTRACT) throw new Error("Unsupported media service contract");
		if (this.service && this.service !== service) throw new Error("A media service is already registered");
		this.service = service;
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			if (this.service === service) {
				this.releasePending = this.invalidate();
				this.service = undefined;
			}
		};
	}
	private owner(): MediaService {
		if (!this.service) throw new Error("No pi.media.v1 service registered");
		return this.service;
	}
	context(signal?: AbortSignal, extra: Partial<MediaOperationContext> = {}): MediaOperationContext {
		return {
			cwd: this.manager.getCwd(),
			storeId: this.manager.getCwd(),
			sessionId: this.manager.getSessionId(),
			operationId: randomUUID(),
			signal: signal ?? new AbortController().signal,
			...extra,
		};
	}
	async invalidate(): Promise<void> {
		this.epoch++;
		this.controller?.abort();
		this.controller = undefined;
		this.invalidateRequest();
		const leases = this.leases;
		this.leases = [];
		await Promise.all(leases.map((l) => l.release()));
	}
	async dispose(): Promise<void> {
		await this.releasePending;
		await this.invalidate();
		await this.service?.disposeSession(this.manager.getSessionId());
		this.service = undefined;
	}
	async capture(input: MediaCaptureInput, signal?: AbortSignal): Promise<MediaReferenceContent> {
		const ref = await this.owner().capture(input, this.context(signal));
		assertMediaReference(ref);
		return ref;
	}
	async describe(ref: MediaReferenceContent, signal?: AbortSignal) {
		assertMediaReference(ref);
		return this.owner().describe(ref, this.context(signal));
	}
	async resolveOriginal(ref: MediaReferenceContent, signal?: AbortSignal) {
		assertMediaReference(ref);
		return this.owner().resolveOriginal(ref, this.context(signal));
	}
	async readImage(ref: MediaReferenceContent, model: Model<Api>, signal?: AbortSignal) {
		const lease = await this.owner().prepareInspection(
			{ reference: ref, model, consumer: "nested-vision", mode: "overview" },
			this.context(signal),
		);
		try {
			if (lease.images.length !== 1) throw new Error("Legacy read image expects one raster");
			signal?.throwIfAborted();
			return { ...lease.images[0] };
		} finally {
			await lease.release();
		}
	}
	async preview(ref: MediaReferenceContent, options: MediaPreviewOptions = {}) {
		const maxDimension = Math.min(options.maxDimension ?? 320, 320),
			maxEncodedBytes = Math.min(options.maxEncodedBytes ?? 96 * 1024, 96 * 1024);
		if (this.owner().preparePreview) {
			const owner = this.owner();
			if (!owner.preparePreview) throw new Error("Video poster capability unavailable");
			const lease = await owner.preparePreview(ref, this.context(options.signal));
			if (
				lease.image.data.length > maxEncodedBytes ||
				Math.max(lease.derivative.width, lease.derivative.height) > maxDimension
			) {
				await lease.release();
				throw new Error("Media preview exceeds display bounds");
			}
			const release = lease.release.bind(lease);
			return {
				...lease,
				async release() {
					await release();
					lease.image.data = "";
				},
			};
		}
		if (ref.kind === "video") throw new Error("Video poster capability unavailable");
		const file = await this.resolveOriginal(ref, options.signal);
		const raster = await prepareImagePreview(file.path, { ...options, maxDimension, maxEncodedBytes });
		const image = { type: "image" as const, data: raster.data, mimeType: raster.mimeType };
		return {
			image,
			derivative: {
				derivativeId: `sha256:${createHash("sha256").update(Buffer.from(raster.data, "base64")).digest("hex")}`,
				assetId: ref.assetId,
				purpose: "thumbnail" as const,
				width: raster.width,
				height: raster.height,
				mimeType: raster.mimeType,
				producer: "pi.image-preview.v1",
				transform: { codec: options.codec, maxDimension, maxEncodedBytes },
			},
			release() {
				raster.data = "";
				image.data = "";
			},
		};
	}
	async open(ref: MediaReferenceContent, signal?: AbortSignal) {
		const file = await this.resolveOriginal(ref, signal);
		if (process.platform !== "darwin")
			throw new Error(`Native media open unavailable on ${process.platform}; original: ${file.path}`);
		await new Promise<void>((resolve, reject) =>
			execFile(
				"/usr/bin/open",
				["-a", ref.kind === "image" ? "Preview" : "QuickTime Player", file.path],
				{ signal },
				(error) => (error ? reject(error) : resolve()),
			),
		);
		return file;
	}
	list() {
		const refs = mediaReferences(
			this.manager.getBranch().flatMap((e) =>
				e.type === "message"
					? [e.message]
					: e.type === "custom_message"
						? [
								{
									role: "custom" as const,
									customType: e.customType,
									content: e.content,
									display: e.display,
									timestamp: Date.parse(e.timestamp),
								},
							]
						: [],
			),
		);
		for (const policy of replayMediaPolicy(this.manager.getBranch()).values())
			if (!refs.some((r) => r.blockId === policy.reference.blockId)) refs.push(policy.reference);
		return refs;
	}
	async inspect(
		ref: MediaReferenceContent,
		options: {
			reason?: string;
			mode?: InspectionRequest["mode"];
			prompt?: string;
			crop?: InspectionRequest["crop"];
			interval?: InspectionRequest["interval"];
		} = {},
	) {
		assertMediaReference(ref);
		if (options.mode === "crop" && !options.crop) throw new Error("Crop inspection requires original coordinates");
		if (options.interval && (!(options.interval.end > options.interval.start) || options.interval.frames < 1))
			throw new Error("Invalid video inspection interval");
		await this.describe(ref);
		await this.invalidate();
		const inspected: MediaReferenceContent = {
			...ref,
			intent: "inspect",
			blockId: randomUUID(),
			inspectionId: randomUUID(),
		};
		const sourceEntryId = this.isStreaming()
			? undefined
			: this.manager.appendMessage({ role: "user", content: [inspected], timestamp: Date.now() });
		this.manager.appendCustomEntry(MEDIA_POLICY_ENTRY, {
			schemaVersion: 1,
			inspectionId: inspected.inspectionId,
			action: "open",
			reference: inspected,
			sourceEntryId,
			reason: options.reason ?? "explicit inspection",
			consumer: "parent-request",
			mode: options.mode,
			crop: options.crop,
			interval: options.interval,
			prompt: options.prompt,
		});
		if (!this.isStreaming()) this.refresh();
		return inspected;
	}
	async finish(inspectionId: string, reason: string, observation?: string) {
		const policy = replayMediaPolicy(this.manager.getBranch()).get(inspectionId);
		if (!policy) throw new Error(`Inspection ${inspectionId} not found on active branch`);
		await this.invalidate();
		if (policy.action === "close") return;
		// Close is authoritative before any reconciliation. A crash cannot reactivate evidence.
		this.manager.appendCustomEntry(MEDIA_POLICY_ENTRY, { ...policy, action: "close", reason, observation });
		if (policy.sourceEntryId && this.manager.buildContextEntries().some((e) => e.id === policy.sourceEntryId)) {
			const projected = this.manager
				.buildSessionProjection()
				.entries.find((e) => e.sourceEntry.id === policy.sourceEntryId)?.messages[0];
			if (projected && "content" in projected && Array.isArray(projected.content))
				this.manager.appendContextEdit(policy.sourceEntryId, { content: projected.content });
		}
		if (!this.isStreaming()) this.refresh();
	}
	async ingest(
		content: AgentContent[],
		ingress: string,
		signal?: AbortSignal,
		extra: Partial<MediaOperationContext> = {},
	): Promise<AgentContent[]> {
		const output: AgentContent[] = [];
		for (const block of content) {
			if (block.type === "image") {
				try {
					const ref = await this.owner().capture(
						{ source: "bytes", data: block.data, mimeType: block.mimeType, ingress, intent: "inspect" },
						this.context(signal, extra),
					);
					assertMediaReference(ref);
					output.push({ ...ref, inspectionId: ref.inspectionId ?? ref.blockId });
				} catch (error) {
					if (ingress !== "tool") throw error;
					output.push(await retainFailedMedia(block, error, this.context(signal, extra)));
				}
			} else {
				if (block.type === "media_reference") assertMediaReference(block);
				output.push(block);
			}
		}
		const failed = failedMedia([{ content: output }]);
		if (failed.length) throw new MediaAdmissionError(failed.map((f) => f.reason).join("; "), output);
		return output;
	}
	async retryAdmission(signal?: AbortSignal): Promise<void> {
		await this.invalidate();
		await repairMediaAdmission(this.manager, this.owner(), (signal, extra) => this.context(signal, extra), signal);
		this.refresh();
	}
	async hydrate(messages: AgentMessage[], model: Model<Api>, signal?: AbortSignal): Promise<AgentMessage[]> {
		const unresolved = unresolvedMedia(this.manager);
		if (unresolved.length)
			throw new Error(
				`Media admission stopped request: ${unresolved.map((f) => `${f.failureId}: ${f.reason}`).join("; ")}`,
			);
		await this.releasePending;
		if (!mediaReferences(messages).some((r) => r.intent === "inspect") && !this.hasRequestLease) return messages;
		await this.invalidate();
		const epoch = this.epoch;
		const controller = new AbortController();
		this.controller = controller;
		const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const policies = replayMediaPolicy(this.manager.getBranch());
		let count = 0,
			bytes = 0;
		const leases: InspectionLease[] = [];
		const output: AgentMessage[] = [];
		try {
			for (const message of messages) {
				if (
					!("content" in message) ||
					!Array.isArray(message.content) ||
					(message.role !== "user" && message.role !== "custom" && message.role !== "toolResult")
				) {
					output.push(message);
					continue;
				}
				const content: AgentContent[] = [];
				for (const block of message.content) {
					if (block.type !== "media_reference") {
						content.push(block);
						continue;
					}
					assertMediaReference(block);
					const policy = policies.get(block.inspectionId ?? block.blockId);
					if (block.intent !== "inspect" || policy?.action === "close" || policy?.consumer === "nested-vision") {
						content.push(block);
						continue;
					}
					if (!model.input.includes("image"))
						throw new Error(`Model ${model.provider}/${model.id} cannot inspect images`);
					const lease = await this.owner().prepareInspection(
						{
							reference: block,
							model,
							consumer: "parent-request",
							mode: policy?.mode,
							crop: policy?.crop,
							interval: policy?.interval,
							prompt: policy?.prompt,
						},
						this.context(requestSignal),
					);
					leases.push(lease);
					requestSignal.throwIfAborted();
					if (epoch !== this.epoch) throw new Error("Media request invalidated during hydration");
					if (lease.coverage)
						content.push({ type: "text", text: `Inspection coverage ${JSON.stringify(lease.coverage)}` });
					for (const image of lease.images) {
						count++;
						bytes += image.data.length;
						content.push(image);
					}
					const limits = model.inputLimits?.images;
					if (count > Math.min(16, limits?.maxPerRequest ?? 16) || bytes > 16 * 1024 * 1024)
						throw new Error(`Active media exceeds request budget: ${count} images, ${bytes} base64 bytes`);
				}
				const messageCount = content.filter((b) => b.type === "image").length;
				if (messageCount > (model.inputLimits?.images?.maxPerMessage ?? 16))
					throw new Error(
						`Message media count ${messageCount} exceeds ${model.inputLimits?.images?.maxPerMessage ?? 16}`,
					);
				output.push({ ...message, content });
			}
			this.leases = leases;
			return output;
		} catch (error) {
			await Promise.all(leases.map((l) => l.release()));
			throw error;
		}
	}
}
