/**
 * Input disposition state machine for Pi v1.1.0 (single-flight admission,
 * generation guards, held custody, replacement reservation, idle pickup).
 */

import { randomUUID } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { SessionManager } from "../session-manager.ts";
import { InputDispositionRecorder } from "./recorder.ts";
import { recoverInputOccurrences } from "./recovery.ts";
import type {
	AdmittedOccurrence,
	EvaluateIdleWorkResult,
	HeldSteeringInput,
	InFlightAdmission,
	InputDisposition,
	InputDispositionEvent,
	InputDispositionState,
	InputIngress,
	QueuedInputRef,
} from "./types.ts";
import { MAX_PENDING_AUTOMATIC_ADMISSIONS } from "./types.ts";

export class InputDispositionController {
	private _enabled = false;
	private _currentGeneration: string;
	private readonly _pending = new Set<string>();
	private _disposed = false;
	private _idleTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly _occurrences = new Map<string, AdmittedOccurrence>();
	private readonly _heldInputs = new Map<string, HeldSteeringInput>();
	private _inFlightAdmission: InFlightAdmission | undefined;
	private readonly _admissionWaitQueue: InFlightAdmission[] = [];
	private _activeRunId: string | undefined;
	private _reservedReplacementOccurrenceId: string | undefined;
	private _deferredIdleEvalScheduled = false;
	private readonly _recorder: InputDispositionRecorder;
	private readonly _executeIdleWorkEvaluation: () => Promise<EvaluateIdleWorkResult>;

	constructor(
		getSessionManager: () => SessionManager,
		emitSessionEvent: (event: InputDispositionEvent) => void,
		executeIdleWorkEvaluation: () => Promise<EvaluateIdleWorkResult>,
	) {
		this._recorder = new InputDispositionRecorder(getSessionManager, emitSessionEvent);
		this._executeIdleWorkEvaluation = executeIdleWorkEvaluation;
		this._currentGeneration = randomUUID();
	}

	dispose(): void {
		this.bumpGeneration("session_replaced");
		this._disposed = true;
		if (this._idleTimer) clearTimeout(this._idleTimer);
	}

	recover(): void {
		for (const occ of recoverInputOccurrences(this._recorder.sessionManager, this._currentGeneration)) {
			if (this._occurrences.has(occ.occurrenceId)) continue;
			this._occurrences.set(occ.occurrenceId, occ);
			if (occ.state === "held") this.holdInput(occ.occurrenceId, occ.text, occ.images);
			this._recorder.emit(occ);
		}
	}

	get enabled(): boolean {
		return this._enabled;
	}

	setEnabled(enabled: boolean): void {
		if (this._enabled === enabled) return;
		this._enabled = enabled;
		if (enabled) this.recover();
		if (!enabled) {
			this.bumpGeneration("mode_off");
		}
	}

	get currentGeneration(): string {
		return this._currentGeneration;
	}

	bumpGeneration(reason?: string): void {
		this._currentGeneration = randomUUID();
		this._pending.clear();
		this._deferredIdleEvalScheduled = false;
		this._reservedReplacementOccurrenceId = undefined;
		// Invalidate all pending admissions waiting or in-flight
		if (this._inFlightAdmission) {
			this._inFlightAdmission.invalidated = true;
			this._inFlightAdmission.resolveGate("invalidated");
			this._inFlightAdmission = undefined;
		}
		while (this._admissionWaitQueue.length > 0) {
			const item = this._admissionWaitQueue.shift();
			if (item) {
				item.invalidated = true;
				item.resolveGate("invalidated");
			}
		}
		if (reason) {
			// Record invalidation of any active occurrences that were not yet delivered
			for (const occurrence of this._occurrences.values()) {
				if (
					occurrence.state === "admitted" ||
					occurrence.state === "classifying" ||
					occurrence.state === "waiting_idle" ||
					occurrence.state === "cancel_requested"
				) {
					this.transition(occurrence.occurrenceId, "cancelled", { detail: reason });
				}
			}
		}
	}

	nextOccurrenceId(): string {
		return `occ_${randomUUID()}`;
	}

	nextRunId(): string {
		return `run_${randomUUID()}`;
	}

	occurrences(): IterableIterator<AdmittedOccurrence> {
		return this._occurrences.values();
	}

	notifyRunStart(runId: string): void {
		this._activeRunId = runId;
	}

	notifyRunSettled(): void {
		this._activeRunId = undefined;
		this._scheduleDeferredIdleEvaluationIfDue();
	}

	get activeRunId(): string | undefined {
		return this._activeRunId;
	}

	get pendingAdmissionCount(): number {
		return this._pending.size + (this._reservedReplacementOccurrenceId ? 1 : 0);
	}

	isAdmissionFull(): boolean {
		return this.pendingAdmissionCount >= MAX_PENDING_AUTOMATIC_ADMISSIONS;
	}

	admitOccurrence(options: {
		text: string;
		images?: ImageContent[];
		ingress?: InputIngress;
		streamingBehavior?: "steer" | "followUp";
	}): { occurrence?: AdmittedOccurrence; isFull: boolean } {
		if (this._disposed) throw new Error("Input session was replaced");
		const isAutomatic = options.ingress === "automatic";
		if (isAutomatic && this.isAdmissionFull()) {
			const occurrenceId = this.nextOccurrenceId();
			const fullOccurrence: AdmittedOccurrence = {
				occurrenceId,
				sessionId: this._recorder.sessionId,
				sessionGeneration: this._currentGeneration,
				capturedRunId: this._activeRunId,
				ingress: "automatic",
				text: options.text,
				images: options.images,
				streamingBehavior: options.streamingBehavior,
				revision: 1,
				state: "blocked",
				detail: "admission_full",
				createdAt: Date.now(),
			};
			this._occurrences.set(occurrenceId, fullOccurrence);
			this._recorder.persist(fullOccurrence, "occurrence", options.text);
			this._recorder.emit(fullOccurrence);
			return { occurrence: fullOccurrence, isFull: true };
		}

		const occurrenceId = this.nextOccurrenceId();
		const occurrence: AdmittedOccurrence = {
			occurrenceId,
			sessionId: this._recorder.sessionId,
			sessionGeneration: this._currentGeneration,
			capturedRunId: this._activeRunId,
			ingress: options.ingress ?? "explicit",
			text: options.text,
			images: options.images,
			streamingBehavior: options.streamingBehavior,
			revision: 1,
			state: "admitted",
			createdAt: Date.now(),
		};
		this._occurrences.set(occurrenceId, occurrence);
		this._pending.add(occurrenceId);
		this._recorder.persist(occurrence, "occurrence");
		this._recorder.emit(occurrence);
		return { occurrence, isFull: false };
	}

	async beginInputDisposition(occurrenceId: string): Promise<"granted" | "invalidated"> {
		const occurrence = this._occurrences.get(occurrenceId);
		if (!occurrence || occurrence.sessionGeneration !== this._currentGeneration) {
			return "invalidated";
		}

		if (!this._inFlightAdmission) {
			this._inFlightAdmission = { occurrenceId, resolveGate: () => {}, invalidated: false };
			this.transition(occurrenceId, "classifying");
			return "granted";
		}

		// Enqueue into arrival-order wait queue
		return new Promise<"granted" | "invalidated">((resolve) => {
			this._admissionWaitQueue.push({
				occurrenceId,
				resolveGate: (result) => {
					if (result === "granted") {
						this.transition(occurrenceId, "classifying");
					}
					resolve(result);
				},
				invalidated: false,
			});
		});
	}

	finishInputDisposition(occurrenceId: string): void {
		this._pending.delete(occurrenceId);
		if (this._inFlightAdmission && this._inFlightAdmission.occurrenceId === occurrenceId) {
			this._inFlightAdmission = undefined;
			this._drainNextAdmission();
		} else {
			const idx = this._admissionWaitQueue.findIndex((item) => item.occurrenceId === occurrenceId);
			if (idx !== -1) {
				this._admissionWaitQueue.splice(idx, 1);
			}
		}
		this._scheduleDeferredIdleEvaluationIfDue();
	}

	private _drainNextAdmission(): void {
		while (this._admissionWaitQueue.length > 0) {
			const next = this._admissionWaitQueue.shift();
			if (!next || next.invalidated) continue;
			const occ = this._occurrences.get(next.occurrenceId);
			if (!occ || occ.sessionGeneration !== this._currentGeneration) {
				next.resolveGate("invalidated");
				continue;
			}
			this._inFlightAdmission = next;
			next.resolveGate("granted");
			return;
		}
	}

	invalidateInFlightDueToInterrupt(): void {
		if (this._inFlightAdmission) {
			const occ = this._occurrences.get(this._inFlightAdmission.occurrenceId);
			if (occ) {
				this.transition(occ.occurrenceId, "held", { detail: "interrupted_by_explicit" });
				this.holdInput(occ.occurrenceId, occ.text, occ.images);
			}
			this._inFlightAdmission.invalidated = true;
			this._inFlightAdmission.resolveGate("invalidated");
			this._inFlightAdmission = undefined;
		}

		while (this._admissionWaitQueue.length > 0) {
			const item = this._admissionWaitQueue.shift();
			if (item) {
				const occ = this._occurrences.get(item.occurrenceId);
				if (occ) {
					this.transition(occ.occurrenceId, "held", { detail: "interrupted_by_explicit" });
					this.holdInput(occ.occurrenceId, occ.text, occ.images);
				}
				item.invalidated = true;
				item.resolveGate("invalidated");
			}
		}
	}

	holdInput(occurrenceId: string, text: string, images?: ImageContent[]): void {
		this._heldInputs.set(occurrenceId, {
			occurrenceId,
			sessionId: this._recorder.sessionId,
			sessionGeneration: this._currentGeneration,
			text,
			images,
			createdAt: Date.now(),
		});
	}

	getHeldInput(occurrenceId: string): HeldSteeringInput | undefined {
		return this._heldInputs.get(occurrenceId);
	}

	takeHeldInput(occurrenceId: string): HeldSteeringInput | undefined {
		const val = this._heldInputs.get(occurrenceId);
		if (val) this._heldInputs.delete(occurrenceId);
		return val;
	}

	getHeldInputs(): readonly HeldSteeringInput[] {
		return Array.from(this._heldInputs.values());
	}

	reserveReplacement(occurrenceId: string): void {
		this._reservedReplacementOccurrenceId = occurrenceId;
	}

	get reservedReplacementOccurrenceId(): string | undefined {
		return this._reservedReplacementOccurrenceId;
	}

	clearReservedReplacement(): void {
		this._reservedReplacementOccurrenceId = undefined;
	}

	/** Rebind an occurrence to its explicit release choice and the current run target. */
	retarget(occurrenceId: string, update: { disposition?: InputDisposition; capturedRunId?: string }): void {
		const occ = this._occurrences.get(occurrenceId);
		if (!occ) return;
		if (update.disposition) occ.disposition = update.disposition;
		occ.capturedRunId = update.capturedRunId;
	}

	getOccurrence(occurrenceId: string): AdmittedOccurrence | undefined {
		return this._occurrences.get(occurrenceId);
	}

	transition(
		occurrenceId: string,
		state: InputDispositionState,
		options?: {
			disposition?: InputDisposition;
			queue?: "steer" | "follow_up";
			queuePosition?: number;
			detail?: string;
		},
	): AdmittedOccurrence | undefined {
		const occurrence = this._occurrences.get(occurrenceId);
		if (!occurrence) return undefined;

		occurrence.state = state;
		occurrence.revision += 1;
		if (options?.disposition) occurrence.disposition = options.disposition;
		if (options?.detail) occurrence.detail = options.detail;

		this._recorder.persist(occurrence, "outcome", undefined, options?.queue, options?.detail);
		this._recorder.emit(occurrence, options?.queue, options?.queuePosition);
		return occurrence;
	}

	getQueuedInput(): QueuedInputRef[] {
		const refs: QueuedInputRef[] = [];
		let steerPos = 1;
		let followUpPos = 1;
		let heldPos = 1;

		for (const occ of this._occurrences.values()) {
			if (occ.sessionGeneration !== this._currentGeneration) continue;
			if (occ.state === "queued") {
				// The explicit disposition is authoritative once set; streamingBehavior is only the pre-claim default.
				const effective = occ.disposition ?? (occ.streamingBehavior === "followUp" ? "follow_up" : "steer");
				if (effective === "steer") {
					refs.push({ occurrenceId: occ.occurrenceId, queue: "steer", position: steerPos++ });
				} else {
					refs.push({ occurrenceId: occ.occurrenceId, queue: "follow_up", position: followUpPos++ });
				}
			} else if (occ.state === "held") {
				refs.push({ occurrenceId: occ.occurrenceId, queue: "held", position: heldPos++ });
			} else if (occ.state === "waiting_idle" && occ.occurrenceId === this._reservedReplacementOccurrenceId) {
				refs.push({ occurrenceId: occ.occurrenceId, queue: "replacement", position: 1 });
			}
		}

		return refs;
	}

	scheduleDeferredIdleEvaluation(): void {
		this._deferredIdleEvalScheduled = true;
		if (!this._activeRunId && this.pendingAdmissionCount === 0) {
			this._scheduleDeferredIdleEvaluationIfDue();
		}
	}

	private _scheduleDeferredIdleEvaluationIfDue(): void {
		if (!this._deferredIdleEvalScheduled) return;
		if (this._disposed || this._activeRunId || this.pendingAdmissionCount > 0) return;

		this._deferredIdleEvalScheduled = false;
		// Run from next event loop tick so any synchronous caller or settling finishes first
		this._idleTimer = setTimeout(() => {
			if (!this._disposed && !this._activeRunId && this.pendingAdmissionCount === 0) {
				void this._executeIdleWorkEvaluation()
					.then((res) => {
						if (!res.started && res.reason === "input_pending") {
							// Chained re-arm if another admission appeared right before run
							this._deferredIdleEvalScheduled = true;
						}
					})
					.catch((error) => {
						console.error("Idle work evaluation failed:", error);
					});
			} else if (!this._disposed) this._deferredIdleEvalScheduled = true;
		}, 0);
	}
}
