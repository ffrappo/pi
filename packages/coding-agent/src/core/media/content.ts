import type { AgentContent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { assertMediaReference, type MediaReferenceContent } from "./types.ts";

export function mediaReferences(messages: readonly AgentMessage[]): MediaReferenceContent[] {
	const refs: MediaReferenceContent[] = [];
	for (const message of messages) {
		if (!("content" in message) || !Array.isArray(message.content)) continue;
		for (const block of message.content)
			if (block.type === "media_reference") {
				assertMediaReference(block);
				refs.push(block);
			}
	}
	return refs;
}
export function mediaDescriptor(ref: MediaReferenceContent): TextContent {
	assertMediaReference(ref);
	return {
		type: "text",
		text: `[${ref.kind} ${ref.assetId}; ${ref.intent}; block ${ref.blockId}${ref.inspectionId ? `; inspection ${ref.inspectionId}` : ""}]`,
	};
}
export function projectMediaContent(content: string | AgentContent[]): string | (TextContent | ImageContent)[] {
	if (typeof content === "string") return content;
	return content.map((block) => {
		switch (block.type) {
			case "text":
			case "image":
				return block;
			case "media_reference":
				return mediaDescriptor(block);
			default:
				throw new Error(`Unresolved custom agent content: ${JSON.stringify(block)}`);
		}
	});
}
export function assertProviderMessages(messages: Message[]): void {
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content)
			if ((block as { type: string }).type === "media_reference")
				throw new Error("Media reference escaped request hydration");
	}
}
