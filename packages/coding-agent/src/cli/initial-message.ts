import type { ImageContent } from "@earendil-works/pi-ai";
import type { MediaCaptureInput } from "../core/media/types.ts";
import type { Args } from "./args.ts";

export interface InitialMessageInput {
	parsed: Args;
	fileText?: string;
	fileImages?: ImageContent[];
	fileMedia?: MediaCaptureInput[];
	stdinContent?: string;
}

export interface InitialMessageResult {
	initialMessage?: string;
	initialImages?: ImageContent[];
	initialMedia?: MediaCaptureInput[];
}

/**
 * Combine stdin content, @file text, and the first CLI message into a single
 * initial prompt for non-interactive mode.
 */
export function buildInitialMessage({
	parsed,
	fileText,
	fileImages,
	fileMedia,
	stdinContent,
}: InitialMessageInput): InitialMessageResult {
	const parts: string[] = [];
	if (stdinContent !== undefined) {
		parts.push(stdinContent);
	}
	if (fileText) {
		parts.push(fileText);
	}

	if (parsed.messages.length > 0) {
		parts.push(parsed.messages[0]);
		parsed.messages.shift();
	}

	return {
		initialMessage: parts.length > 0 ? parts.join("") : undefined,
		initialImages: fileImages && fileImages.length > 0 ? fileImages : undefined,
		initialMedia: fileMedia,
	};
}
