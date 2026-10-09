import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { SessionManager } from "../session-manager.ts";
import {
	type AdmittedOccurrence,
	INPUT_DISPOSITION_CUSTOM_TYPE,
	type InputDispositionEvent,
	type InputDispositionJournalEntry,
} from "./types.ts";

/**
 * Read the last JSONL line of `file`, bounded to the final `tailBytes` bytes. The writer
 * (SessionManager) appends exactly one newline-terminated JSON line per entry, so the
 * last non-empty line of the tail is the append being confirmed.
 */
function readLastJsonLine(file: string, tailBytes: number): { id?: string; data?: unknown } | undefined {
	const fd = openSync(file, "r");
	try {
		// Size comes from the opened descriptor so the bounded window and the read share one
		// fd: a concurrent truncate or extend between stat and open cannot skew the range.
		const size = fstatSync(fd).size;
		if (size === 0) return undefined;
		const bytes = Math.min(size, tailBytes);
		const buffer = Buffer.alloc(bytes);
		const read = readSync(fd, buffer, 0, bytes, size - bytes);
		const lines = buffer.subarray(0, read).toString("utf8").split("\n");
		// The file ends with a newline and the window may open mid-previous-line; the append
		// being confirmed is the last non-empty line.
		let last = "";
		for (let i = lines.length - 1; i >= 0; i--) {
			if (lines[i].trim().length > 0) {
				last = lines[i];
				break;
			}
		}
		if (last.length === 0) return undefined;
		return JSON.parse(last);
	} finally {
		closeSync(fd);
	}
}

/** One journal owner. Unconfirmed writes stop admission; they never become success. */
export class InputDispositionRecorder {
	private failure: unknown;
	private readonly manager: () => SessionManager;
	private readonly emitEvent: (event: InputDispositionEvent) => void;
	constructor(manager: () => SessionManager, emitEvent: (event: InputDispositionEvent) => void) {
		this.manager = manager;
		this.emitEvent = emitEvent;
	}
	get sessionId(): string {
		return this.manager().getSessionId();
	}
	get sessionManager(): SessionManager {
		return this.manager();
	}
	persist(
		occ: AdmittedOccurrence,
		kind: "occurrence" | "outcome",
		retainedText?: string,
		queue?: string,
		detail?: string,
	): string {
		if (this.failure) throw this.failure;
		const manager = this.manager();
		if (occ.sessionId !== manager.getSessionId()) throw new Error("Disposition journal target changed");
		const file = manager.getSessionFile();
		if (!manager.isPersisted() || !file) throw new Error("Input disposition requires a persisted session");
		const entry: InputDispositionJournalEntry = {
			kind,
			occurrenceId: occ.occurrenceId,
			sessionId: occ.sessionId,
			ingress: occ.ingress,
			state: occ.state,
			disposition: occ.disposition,
			queue,
			text: retainedText ?? occ.text,
			images: occ.images,
			sessionGeneration: occ.sessionGeneration,
			revision: occ.revision,
			detail: detail ?? occ.detail,
			at: Date.now(),
		};
		const expected = JSON.stringify(entry);
		try {
			const id = manager.appendCustomEntry(INPUT_DISPOSITION_CUSTOM_TYPE, entry);
			if (manager.getSessionFile() !== file) throw new Error(`Disposition journal target changed: ${id}`);
			// Fresh sessions keep entries in memory until the first user or assistant message
			// flush; custody must be durable at persist time, so the owning manager flushes now.
			manager.ensureFlushed();
			// Confirm only the actual append: last disk line must carry the exact id and payload.
			// The line is the entry serialization plus bounded wrapper fields (type, ids, timestamp).
			const saved = readLastJsonLine(file, Buffer.byteLength(expected, "utf8") + 4096);
			if (!saved || saved.id !== id || JSON.stringify(saved.data) !== expected)
				throw new Error(`Input custody unconfirmed: ${id}`);
			return id;
		} catch (error) {
			// The append, its target recheck, the first flush and the confirmation are one
			// custody unit: any failure here is sticky, so later admissions halt until the
			// actual repair or a session reload. First error wins; no fallback writer.
			this.failure ??= error;
			throw error;
		}
	}
	emit(occ: AdmittedOccurrence, queue?: "steer" | "follow_up", queuePosition?: number): void {
		this.emitEvent({
			type: "input_disposition",
			occurrenceId: occ.occurrenceId,
			sessionId: occ.sessionId,
			state: occ.state,
			ingress: occ.ingress,
			disposition: occ.disposition,
			queue,
			queuePosition,
			revision: occ.revision,
			detail: occ.detail,
		});
	}
}
