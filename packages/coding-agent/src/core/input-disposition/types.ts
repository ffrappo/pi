/**
 * Input disposition types and constants for Pi v1.1.0.
 *
 * Implements the contract in:
 * docs/plans/2026-10-09-prebehaviour-jev-gate.md
 * artifacts/implementation/jev-input-2026-10-09/native-api.md
 */

import type { ImageContent } from "@earendil-works/pi-ai";

export const INPUT_DISPOSITION_VERSION = 1;
export const INPUT_DISPOSITION_CUSTOM_TYPE = "pi.input.disposition";
export const MAX_PENDING_AUTOMATIC_ADMISSIONS = 8;

export type InputIngress = "automatic" | "explicit";
export type InputDisposition = "send_now" | "steer" | "follow_up" | "interrupt_now";

export type InputDispositionState =
	| "admitted"
	| "classifying"
	| "queued"
	| "cancel_requested"
	| "waiting_idle"
	| "dispatched"
	| "replacement_started"
	| "delivered"
	| "held"
	| "released"
	| "conflict"
	| "blocked"
	| "failed"
	| "cancelled";

export interface InputDispositionEvent {
	type: "input_disposition";
	occurrenceId: string;
	sessionId: string;
	state: InputDispositionState;
	ingress: InputIngress;
	disposition?: InputDisposition;
	queue?: "steer" | "follow_up";
	queuePosition?: number;
	revision: number;
	detail?: string;
}

export interface QueuedInputRef {
	occurrenceId: string;
	queue: "steer" | "follow_up" | "held" | "replacement";
	position: number;
}

export interface EvaluateIdleWorkResult {
	started: boolean;
	ranWork: boolean;
	reason?: "busy" | "input_pending" | "deferred_settling" | "empty_context";
}

export interface InputDispositionJournalEntry {
	kind: "occurrence" | "outcome";
	occurrenceId: string;
	sessionId: string;
	ingress: InputIngress;
	state: InputDispositionState;
	disposition?: InputDisposition;
	queue?: string;
	text?: string;
	images?: ImageContent[];
	sessionGeneration?: string;
	revision?: number;
	detail?: string;
	at: number;
}

export interface AdmittedOccurrence {
	occurrenceId: string;
	sessionId: string;
	sessionGeneration: string;
	capturedRunId?: string;
	ingress: InputIngress;
	text: string;
	images?: ImageContent[];
	streamingBehavior?: "steer" | "followUp";
	revision: number;
	state: InputDispositionState;
	disposition?: InputDisposition;
	detail?: string;
	createdAt: number;
}

export interface HeldSteeringInput {
	occurrenceId: string;
	sessionId: string;
	sessionGeneration: string;
	text: string;
	images?: ImageContent[];
	createdAt: number;
}

export interface InFlightAdmission {
	occurrenceId: string;
	resolveGate: (granted: "granted" | "invalidated") => void;
	invalidated: boolean;
}
