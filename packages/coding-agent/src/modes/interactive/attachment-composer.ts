import type { Editor, StagedAttachment } from "@earendil-works/pi-tui";
import type { MediaCaptureInput, MediaHandle, MediaReferenceContent } from "../../core/media/types.ts";

/** Keeps staged identities separate from text, including undo and rejected submissions. */
export class AttachmentComposer {
	private editor: Editor;
	private references = new Map<string, MediaReferenceContent>();
	constructor(editor: Editor) {
		this.editor = editor;
	}
	async stage(
		media: MediaHandle,
		input: MediaCaptureInput,
		source: StagedAttachment["source"],
		signal?: AbortSignal,
	): Promise<void> {
		const ref = await media.capture(input, signal);
		this.references.set(ref.blockId, ref);
		this.editor.stageAttachment({
			id: ref.blockId,
			source,
			originalLocator: input.source === "path" ? input.path : ref.assetId,
			intent: ref.intent,
			label: input.source === "path" ? input.path : ref.kind,
		});
	}
	selected(): MediaReferenceContent[] {
		return this.editor.getAttachments().map((attachment) => {
			const ref = this.references.get(attachment.id);
			if (!ref) throw new Error(`Staged attachment ${attachment.id} lost its reference`);
			return { ...ref, intent: attachment.intent };
		});
	}
	take(): MediaReferenceContent[] {
		const refs = this.selected();
		this.editor.clearAttachments();
		return refs;
	}
	restore(refs: readonly MediaReferenceContent[]): void {
		for (const ref of refs) {
			this.references.set(ref.blockId, ref);
			if (!this.editor.getAttachments().some((item) => item.id === ref.blockId))
				this.editor.stageAttachment({
					id: ref.blockId,
					source: "queue",
					originalLocator: ref.assetId,
					intent: ref.intent,
					label: `${ref.kind} ${ref.assetId.slice(7, 15)}`,
				});
		}
	}
	clear(): void {
		this.editor.clearAttachments();
	}
}
