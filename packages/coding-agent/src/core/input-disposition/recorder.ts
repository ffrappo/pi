/**
 * Durable journal persistence and outcome-event emission for input dispositions.
 */

import type { SessionManager } from "../session-manager.ts";
import {
	type AdmittedOccurrence,
	INPUT_DISPOSITION_CUSTOM_TYPE,
	type InputDispositionEvent,
	type InputDispositionJournalEntry,
} from "./types.ts";

export class InputDispositionRecorder {
	private readonly _getSessionManager: () => SessionManager;
	private readonly _emitSessionEvent: (event: InputDispositionEvent) => void;

	constructor(getSessionManager: () => SessionManager, emitSessionEvent: (event: InputDispositionEvent) => void) {
		this._getSessionManager = getSessionManager;
		this._emitSessionEvent = emitSessionEvent;
	}

	get sessionId(): string {
		return this._getSessionManager().getSessionId();
	}

	persist(
		occ: AdmittedOccurrence,
		kind: "occurrence" | "outcome",
		retainedText?: string,
		queue?: string,
		detail?: string,
	): void {
		try {
			const entry: InputDispositionJournalEntry = {
				kind,
				occurrenceId: occ.occurrenceId,
				sessionId: occ.sessionId,
				ingress: occ.ingress,
				state: occ.state,
				disposition: occ.disposition,
				queue,
				text: retainedText,
				detail: detail ?? occ.detail,
				at: Date.now(),
			};
			this._getSessionManager().appendCustomEntry(INPUT_DISPOSITION_CUSTOM_TYPE, entry);
		} catch {
			// Persistence failure must not throw into dispatcher
		}
	}

	emit(occ: AdmittedOccurrence, queue?: "steer" | "follow_up", queuePosition?: number): void {
		this._emitSessionEvent({
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
