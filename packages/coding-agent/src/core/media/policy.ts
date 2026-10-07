import type { AgentContent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "../session-manager.ts";
import { mediaReferences } from "./content.ts";
import {
	type ActiveMediaCheckpoint,
	assertMediaReference,
	type MediaPolicyEvent,
	type MediaReferenceContent,
} from "./types.ts";
export const MEDIA_POLICY_ENTRY = "pi.media.policy.v1";

export function replayMediaPolicy(entries: readonly SessionEntry[]): Map<string, MediaPolicyEvent> {
	const policies = new Map<string, MediaPolicyEvent>();
	for (const entry of entries) {
		if (entry.type === "compaction" && entry.activeMedia) {
			if (entry.activeMedia.schemaVersion !== 1) throw new Error("Unsupported activeMedia checkpoint");
			for (const event of entry.activeMedia.inspections)
				if (!policies.has(event.inspectionId)) policies.set(event.inspectionId, event);
		}
		if (entry.type === "message" || entry.type === "custom_message") {
			const content =
				entry.type === "message" ? ("content" in entry.message ? entry.message.content : undefined) : entry.content;
			if (Array.isArray(content))
				for (const ref of content) {
					if (ref.type !== "media_reference" || ref.intent !== "inspect") continue;
					assertMediaReference(ref);
					const id = ref.inspectionId ?? ref.blockId;
					if (!policies.has(id))
						policies.set(id, {
							schemaVersion: 1,
							inspectionId: id,
							action: "open",
							reference: ref,
							sourceEntryId: entry.id,
							reason: "explicit ingress",
							consumer: "parent-request",
						});
				}
		}
		if (entry.type === "custom" && entry.customType === MEDIA_POLICY_ENTRY) {
			const event = entry.data as MediaPolicyEvent;
			if (!event || event.schemaVersion !== 1 || !["open", "close"].includes(event.action) || !event.inspectionId)
				throw new Error("Invalid media policy entry");
			assertMediaReference(event.reference);
			policies.set(event.inspectionId, event);
		}
	}
	return policies;
}
export function activeMediaCheckpoint(entries: readonly SessionEntry[]): ActiveMediaCheckpoint {
	return {
		schemaVersion: 1,
		inspections: [...replayMediaPolicy(entries).values()].filter(
			(e) => e.action === "open" && e.consumer === "parent-request",
		),
	};
}
export function maskClosedMedia(message: AgentMessage, policies: Map<string, MediaPolicyEvent>): AgentMessage {
	if (
		!("content" in message) ||
		!Array.isArray(message.content) ||
		(message.role !== "user" && message.role !== "toolResult" && message.role !== "custom")
	)
		return message;
	const content: AgentContent[] = message.content.filter(
		(block) =>
			block.type !== "media_reference" || policies.get(block.inspectionId ?? block.blockId)?.action !== "close",
	);
	return { ...message, content };
}
export function checkpointMessages(
	checkpoint: ActiveMediaCheckpoint | undefined,
	selected: readonly AgentMessage[],
	policies: Map<string, MediaPolicyEvent>,
	timestamp: number,
): AgentMessage[] {
	if (!checkpoint) return [];
	const kept = new Set(mediaReferences(selected).map((r) => r.blockId));
	const refs: MediaReferenceContent[] = checkpoint.inspections
		.filter(
			(e) =>
				e.action === "open" && !kept.has(e.reference.blockId) && policies.get(e.inspectionId)?.action !== "close",
		)
		.map((e) => e.reference);
	return refs.length
		? [
				{
					role: "user",
					content: [{ type: "text", text: "Active visual evidence retained through compaction." }, ...refs],
					timestamp,
				},
			]
		: [];
}
