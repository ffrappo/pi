import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentContent } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { MediaOperationContext } from "./types.ts";

export interface MediaAdmissionFailureContent {
	type: "media_admission_failure";
	schemaVersion: 1;
	failureId: string;
	blockId: string;
	custodyPath: string;
	digest: string;
	mimeType: string;
	reason: string;
	toolCallId?: string;
	parentToolCallId?: string;
}
declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentContent {
		media_admission_failure: MediaAdmissionFailureContent;
	}
}
export const MEDIA_ADMISSION_ENTRY = "pi.media.admission.v1";
export interface MediaAdmissionRecord {
	schemaVersion: 1;
	targetId: string;
	failures: MediaAdmissionFailureContent[];
	resolved?: boolean;
}
export class MediaAdmissionError extends Error {
	content: AgentContent[];
	constructor(reason: string, content: AgentContent[]) {
		super(reason);
		this.name = "MediaAdmissionError";
		this.content = content;
	}
}
/** Failed producer output stays in private durable custody, not in a provider request or a successful asset store. */
export async function retainFailedMedia(
	image: ImageContent,
	error: unknown,
	ctx: MediaOperationContext,
): Promise<MediaAdmissionFailureContent> {
	const failureId = randomUUID(),
		blockId = ctx.sourceBlockId ?? randomUUID();
	const directory = join(resolve(ctx.cwd), "artifacts/media-failures", failureId);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const raw = JSON.stringify(image),
		digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
	const custodyPath = join(directory, "failed-original.json");
	const file = await open(custodyPath, "wx", 0o600);
	try {
		await file.writeFile(raw);
		await file.sync();
	} finally {
		await file.close();
	}
	const failure: MediaAdmissionFailureContent = {
		type: "media_admission_failure",
		schemaVersion: 1,
		failureId,
		blockId,
		custodyPath,
		digest,
		mimeType: image.mimeType,
		reason: error instanceof Error ? error.message : String(error),
		toolCallId: ctx.toolCallId,
		parentToolCallId: ctx.parentToolCallId,
	};
	const index = await open(join(directory, "failure.json"), "wx", 0o600);
	try {
		await index.writeFile(`${JSON.stringify(failure)}\n`);
		await index.sync();
	} finally {
		await index.close();
	}
	return failure;
}
export async function loadFailedMedia(
	failure: MediaAdmissionFailureContent,
	signal?: AbortSignal,
): Promise<ImageContent> {
	if (failure.schemaVersion !== 1) throw new Error("Unsupported media failure schema");
	const raw = await readFile(failure.custodyPath, { encoding: "utf8", signal });
	if (`sha256:${createHash("sha256").update(raw).digest("hex")}` !== failure.digest)
		throw new Error(`Failed media custody changed: ${failure.failureId}`);
	const block: unknown = JSON.parse(raw);
	if (
		!block ||
		typeof block !== "object" ||
		!("type" in block) ||
		block.type !== "image" ||
		!("data" in block) ||
		typeof block.data !== "string" ||
		!("mimeType" in block) ||
		typeof block.mimeType !== "string"
	)
		throw new Error("Invalid failed original image");
	return { type: "image", data: block.data, mimeType: block.mimeType };
}
export function failedMedia(messages: readonly { content?: unknown }[]): MediaAdmissionFailureContent[] {
	return messages.flatMap((m) =>
		Array.isArray(m.content)
			? m.content.filter((b): b is MediaAdmissionFailureContent => b?.type === "media_admission_failure")
			: [],
	);
}
