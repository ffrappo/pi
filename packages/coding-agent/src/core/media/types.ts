import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";

export const MEDIA_CONTRACT = "pi.media.v1" as const;
export interface MediaStoreLocator {
	storeId: string;
	root: string;
}
export interface MediaReferenceContent {
	type: "media_reference";
	schemaVersion: 1;
	assetId: string;
	store: MediaStoreLocator;
	kind: "image" | "video";
	intent: "view" | "inspect";
	blockId: string;
	derivativeId?: string;
	inspectionId?: string;
}
export interface MediaProvenance {
	ingress: string;
	capturedAt: string;
	sourcePath?: string;
	sourceUri?: string;
	toolCallId?: string;
	parentToolCallId?: string;
	sourceEntryId?: string;
	sourceBlockId?: string;
	limitation?: string;
}
export interface MediaAsset {
	schemaVersion: 1;
	assetId: string;
	mimeType: string;
	byteSize: number;
	canonicalPath: string;
	name?: string;
	availability?: "available" | "missing" | "unresolved";
	kind: "image" | "video";
	width?: number;
	height?: number;
	durationSeconds?: number;
	streams?: Array<{ index: number; type: string; codec: string }>;
	provenance: MediaProvenance[];
}
export interface MediaDerivative {
	derivativeId: string;
	assetId: string;
	purpose: "thumbnail" | "poster" | "inspection" | "crop" | "frame";
	width: number;
	height: number;
	mimeType: string;
	producer: string;
	transform: Record<string, unknown>;
}
export interface MediaOperationContext {
	cwd: string;
	storeId: string;
	sessionId: string;
	operationId: string;
	signal: AbortSignal;
	toolCallId?: string;
	parentToolCallId?: string;
	sourceEntryId?: string;
	sourceBlockId?: string;
}
export type MediaCaptureInput = (
	| { source: "path"; path: string }
	| { source: "bytes"; data: string; mimeType: string }
) & {
	ingress: string;
	intent: "view" | "inspect";
	blockId?: string;
};
export interface VerifiedMediaFile {
	path: string;
	digest: string;
	asset: MediaAsset;
}
export interface InspectionRequest {
	reference: MediaReferenceContent;
	model: Model<Api>;
	consumer: "parent-request" | "nested-vision";
	mode?: "overview" | "original" | "crop" | "frames";
	crop?: { x: number; y: number; width: number; height: number };
	interval?: { start: number; end: number; frames: number };
	prompt?: string;
}
export interface InspectionLease {
	images: ImageContent[];
	derivatives: MediaDerivative[];
	coverage?: Record<string, unknown>;
	release(): void | Promise<void>;
}
export interface MediaPreviewLease {
	image: ImageContent;
	derivative: MediaDerivative;
	release(): void | Promise<void>;
}
export interface MediaService {
	contract: typeof MEDIA_CONTRACT;
	capture(input: MediaCaptureInput, ctx: MediaOperationContext): Promise<MediaReferenceContent>;
	describe(ref: MediaReferenceContent, ctx: MediaOperationContext): Promise<MediaAsset>;
	resolveOriginal(ref: MediaReferenceContent, ctx: MediaOperationContext): Promise<VerifiedMediaFile>;
	prepareInspection(input: InspectionRequest, ctx: MediaOperationContext): Promise<InspectionLease>;
	preparePreview?(ref: MediaReferenceContent, ctx: MediaOperationContext): Promise<MediaPreviewLease>;
	disposeSession(sessionId: string): Promise<void>;
}
export interface MediaPolicyEvent {
	schemaVersion: 1;
	inspectionId: string;
	action: "open" | "close";
	reference: MediaReferenceContent;
	sourceEntryId?: string;
	reason: string;
	observation?: string;
	consumer: "parent-request" | "nested-vision";
	provider?: string;
	model?: string;
	mode?: InspectionRequest["mode"];
	crop?: InspectionRequest["crop"];
	interval?: InspectionRequest["interval"];
	prompt?: string;
}
export interface ActiveMediaCheckpoint {
	schemaVersion: 1;
	inspections: MediaPolicyEvent[];
}
export interface MediaPreviewOptions {
	signal?: AbortSignal;
	codec?: "png" | "jpeg";
	maxDimension?: number;
	maxEncodedBytes?: number;
}
export interface MediaHandle {
	readonly capabilities: typeof MEDIA_CONTRACT;
	capture(input: MediaCaptureInput, signal?: AbortSignal): Promise<MediaReferenceContent>;
	describe(ref: MediaReferenceContent, signal?: AbortSignal): Promise<MediaAsset>;
	resolveOriginal(ref: MediaReferenceContent, signal?: AbortSignal): Promise<VerifiedMediaFile>;
	preview(ref: MediaReferenceContent, options?: MediaPreviewOptions): Promise<MediaPreviewLease>;
	open(ref: MediaReferenceContent, signal?: AbortSignal): Promise<VerifiedMediaFile>;
	list(): MediaReferenceContent[];
	inspect(
		ref: MediaReferenceContent,
		options?: {
			reason?: string;
			mode?: InspectionRequest["mode"];
			prompt?: string;
			crop?: InspectionRequest["crop"];
			interval?: InspectionRequest["interval"];
		},
	): Promise<MediaReferenceContent>;
	finish(inspectionId: string, reason: string, observation?: string): Promise<void>;
	retryAdmission(signal?: AbortSignal): Promise<void>;
}

declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentContent {
		media_reference: MediaReferenceContent;
	}
}

export function assertMediaReference(value: MediaReferenceContent): void {
	if (
		value.schemaVersion !== 1 ||
		!/^sha256:[a-f0-9]{64}$/.test(value.assetId) ||
		!value.blockId ||
		!value.store?.root ||
		!value.store.storeId ||
		!["image", "video"].includes(value.kind) ||
		!["view", "inspect"].includes(value.intent)
	)
		throw new Error("Invalid pi.media.v1 reference");
}
