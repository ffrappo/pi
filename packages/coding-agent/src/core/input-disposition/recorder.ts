import { existsSync, readFileSync } from "node:fs";
import type { SessionManager } from "../session-manager.ts";
import {
	type AdmittedOccurrence,
	INPUT_DISPOSITION_CUSTOM_TYPE,
	type InputDispositionEvent,
	type InputDispositionJournalEntry,
} from "./types.ts";

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
		const id = manager.appendCustomEntry(INPUT_DISPOSITION_CUSTOM_TYPE, entry);
		if (!existsSync(file)) return id; // fresh session: the first user-message flush writes this entry too
		try {
			const disk = readFileSync(manager.getSessionFile()!, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const saved = disk.find((value) => value.id === id);
			if (!saved || JSON.stringify(saved.data) !== JSON.stringify(entry))
				throw new Error(`Input custody unconfirmed: ${id}`);
		} catch (error) {
			this.failure = error;
			throw error;
		}
		return id;
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
