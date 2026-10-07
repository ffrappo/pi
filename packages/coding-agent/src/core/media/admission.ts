import type { AgentContent } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "../session-manager.ts";
import { failedMedia, loadFailedMedia, MEDIA_ADMISSION_ENTRY, type MediaAdmissionRecord } from "./failures.ts";
import { assertMediaReference, type MediaOperationContext, type MediaService } from "./types.ts";
export function mediaAdmissionRecords(manager: SessionManager) {
	const records = new Map<string, MediaAdmissionRecord>();
	for (const entry of manager.getBranch())
		if (entry.type === "custom" && entry.customType === MEDIA_ADMISSION_ENTRY) {
			const record = entry.data as MediaAdmissionRecord;
			if (record.schemaVersion !== 1) throw new Error("Unknown media admission schema");
			records.set(record.targetId, record);
		}
	return records;
}
export function unresolvedMedia(manager: SessionManager) {
	const unresolved = [...mediaAdmissionRecords(manager).values()]
		.filter((r) => !r.resolved)
		.flatMap((r) => r.failures);
	unresolved.push(
		...failedMedia(manager.buildSessionProjection().messages.filter((m) => "content" in m)).filter(
			(f) => !unresolved.some((u) => u.failureId === f.failureId),
		),
	);
	return unresolved;
}
export async function repairMediaAdmission(
	manager: SessionManager,
	service: MediaService,
	context: (signal?: AbortSignal, extra?: Partial<MediaOperationContext>) => MediaOperationContext,
	signal?: AbortSignal,
) {
	const projection = manager.buildSessionProjection().entries;
	for (const record of mediaAdmissionRecords(manager).values()) {
		if (record.resolved || projection.some((p) => p.sourceEntry.id === record.targetId)) continue;
		const source = manager.getEntry(record.targetId);
		if (source?.type !== "message") throw new Error("Failed media source entry missing");
		projection.push({ sourceEntry: source, messages: [source.message] });
	}
	for (const projected of projection)
		for (const message of projected.messages) {
			if (!("content" in message) || !Array.isArray(message.content) || !failedMedia([message]).length) continue;
			if (message.role !== "user" && message.role !== "toolResult" && message.role !== "custom")
				throw new Error("Invalid failed media owner");
			const content: AgentContent[] = [];
			for (const block of message.content) {
				if (block.type !== "media_admission_failure") {
					content.push(block);
					continue;
				}
				const original = await loadFailedMedia(block, signal);
				const ref = await service.capture(
					{
						source: "bytes",
						data: original.data,
						mimeType: original.mimeType,
						ingress: "admission-repair",
						intent: "inspect",
						blockId: block.blockId,
					},
					context(signal, {
						toolCallId: block.toolCallId,
						parentToolCallId: block.parentToolCallId,
						sourceEntryId: projected.sourceEntry.id,
						sourceBlockId: block.blockId,
					}),
				);
				assertMediaReference(ref);
				content.push(ref);
			}
			manager.appendContextEdit(projected.sourceEntry.id, { content });
			manager.appendCustomEntry(MEDIA_ADMISSION_ENTRY, {
				schemaVersion: 1,
				targetId: projected.sourceEntry.id,
				failures: [],
				resolved: true,
			});
		}
}
