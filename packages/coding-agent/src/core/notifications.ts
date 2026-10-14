import type { CustomEntry, SessionEntry } from "./session-manager.ts";

/** Host-rendered UI data. Custom entries never contribute model messages. */
export const NOTIFICATION_ENTRY = "pi:notification";
export type NotificationLevel = "info" | "warning" | "error";
export interface NotificationData {
	text: string;
	level: NotificationLevel;
	sourceEntryId?: string;
}

export function isNotificationEntry(entry: CustomEntry): boolean {
	return entry.customType === NOTIFICATION_ENTRY || entry.customType === "pi-fornace:notification";
}

function isNotificationData(value: unknown): value is NotificationData {
	if (!value || typeof value !== "object") return false;
	const data = value as Partial<NotificationData>;
	return (
		typeof data.text === "string" &&
		["info", "warning", "error"].includes(data.level ?? "") &&
		(data.sourceEntryId === undefined || typeof data.sourceEntryId === "string")
	);
}

export function readNotification(entry: CustomEntry): NotificationData {
	const data = entry.data;
	if (!isNotificationData(data)) {
		throw new Error(`Invalid notification entry ${entry.id}`);
	}
	return data;
}

/** Retain selected-branch warning/error display without appending restoration entries. */
export function notificationDisplayEntries(
	entries: readonly SessionEntry[],
	branch: readonly SessionEntry[],
): SessionEntry[] {
	const visible = new Set(entries.map((entry) => entry.id));
	const displayed = new Set<string>();
	const result: SessionEntry[] = [];
	for (const entry of branch) {
		if (entry.type !== "custom" || !isNotificationEntry(entry)) {
			if (visible.has(entry.id)) result.push(entry);
			continue;
		}
		const data = entry.data;
		if (!isNotificationData(data)) {
			// Malformed retained records must reach the native diagnostic renderer.
			result.push(entry);
			continue;
		}
		const source = data.sourceEntryId ?? entry.id;
		if (!displayed.has(source) && (visible.has(entry.id) || data.level !== "info")) {
			result.push(entry);
			displayed.add(source);
		}
	}
	const compaction = entries[0];
	return compaction?.type === "compaction"
		? [compaction, ...result.filter((entry) => entry.id !== compaction.id)]
		: result;
}
