import type { SessionManager } from "../session-manager.ts";
import { type AdmittedOccurrence, INPUT_DISPOSITION_CUSTOM_TYPE, type InputDispositionJournalEntry } from "./types.ts";

/** Reconcile by message lineage, never text. Unconsumed/uncertain acceptance is held, not replayed. */
export function recoverInputOccurrences(manager: SessionManager, generation: string): AdmittedOccurrence[] {
	const records = new Map<string, InputDispositionJournalEntry>();
	const consumed = new Set<string>();
	for (const entry of manager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "user" && entry.message.inputOccurrenceId) {
			consumed.add(entry.message.inputOccurrenceId);
		}
		if (entry.type === "custom" && entry.customType === INPUT_DISPOSITION_CUSTOM_TYPE) {
			const data = entry.data as InputDispositionJournalEntry;
			if (!data.occurrenceId || typeof data.text !== "string")
				throw new Error("Input journal lacks recoverable custody");
			records.set(data.occurrenceId, data);
		}
	}
	return [...records.values()].map((record) => {
		const delivered = consumed.has(record.occurrenceId);
		const terminal =
			record.state === "cancelled" || (record.state === "blocked" && record.detail === "consumed_by_handler");
		return {
			occurrenceId: record.occurrenceId,
			sessionId: manager.getSessionId(),
			sessionGeneration: generation,
			ingress: record.ingress,
			text: record.text!,
			images: record.images,
			revision: record.revision ?? 1,
			state: delivered ? "delivered" : terminal ? record.state : "held",
			disposition: record.disposition,
			detail: delivered ? "reconciled_user_entry" : terminal ? record.detail : "restart_requires_resolution",
			createdAt: record.at,
		};
	});
}
