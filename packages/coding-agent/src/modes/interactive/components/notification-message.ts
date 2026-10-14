import { type Component, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import type { NotificationLevel } from "../../../core/notifications.ts";
import { type Theme, theme } from "../theme/theme.ts";

export type { NotificationLevel } from "../../../core/notifications.ts";

export interface NotificationMessageOptions {
	level?: NotificationLevel;
	detail?: string;
	expanded?: boolean;
	paddingX?: number;
}

const labels = { info: "Info", warning: "Warning", error: "Error" } as const;
const colors = { info: "accent", warning: "warning", error: "error" } as const;

function plainText(text: string): string {
	return stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ");
}

/** Shared content for host diagnostics and extension notices. The caller owns spacing. */
export class NotificationMessageComponent implements Component {
	private message: string;
	private readonly options: NotificationMessageOptions;
	private readonly getTheme: () => Theme;

	constructor(message: string, options: NotificationMessageOptions = {}, getTheme: () => Theme = () => theme) {
		this.message = message;
		this.options = options;
		this.getTheme = getTheme;
	}

	setText(message: string): void {
		this.message = message;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const currentTheme = this.getTheme();
		const level = this.options.level ?? "info";
		const heading = currentTheme.bold(currentTheme.fg(colors[level], labels[level]));
		const body = currentTheme.fg("text", plainText(this.message));
		const detail =
			this.options.expanded && this.options.detail
				? `\n${currentTheme.fg("muted", plainText(this.options.detail))}`
				: "";
		return new Text(`${heading} · ${body}${detail}`, this.options.paddingX ?? 0, 0).render(width);
	}

	invalidate(): void {}
}
