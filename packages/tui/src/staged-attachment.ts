export interface StagedAttachment {
	id: string;
	source: "clipboard" | "file" | "drop" | "queue";
	originalLocator: string;
	intent: "view" | "inspect";
	label: string;
}
