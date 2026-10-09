/**
 * Native input disposition for Pi v1.1.0.
 *
 * Implements the contract in:
 * docs/plans/2026-10-09-prebehaviour-jev-gate.md
 * artifacts/implementation/jev-input-2026-10-09/native-api.md
 */

export { InputDispositionController } from "./input-disposition/controller.ts";
export { InputDispositionRecorder } from "./input-disposition/recorder.ts";
export {
	type AdmittedOccurrence,
	type EvaluateIdleWorkResult,
	type HeldSteeringInput,
	INPUT_DISPOSITION_CUSTOM_TYPE,
	INPUT_DISPOSITION_VERSION,
	type InputDisposition,
	type InputDispositionEvent,
	type InputDispositionJournalEntry,
	type InputDispositionState,
	type InputIngress,
	MAX_PENDING_AUTOMATIC_ADMISSIONS,
	type QueuedInputRef,
} from "./input-disposition/types.ts";
