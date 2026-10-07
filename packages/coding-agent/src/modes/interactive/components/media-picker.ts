import { type Component, getKeybindings, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import type { MediaRow } from "./media-row.ts";
/** Reuses transcript rows, never intercepts keys in the ordinary editor. */
export class MediaPicker implements Component {
	private rows: readonly MediaRow[];
	private index = 0;
	private ui: TUI;
	private done: () => void;
	constructor(rows: readonly MediaRow[], ui: TUI, done: () => void) {
		this.rows = rows.map((row) => row.createView());
		this.ui = ui;
		this.done = done;
	}
	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.done();
			return;
		}
		if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
			this.rows[this.index]?.setVisible(false);
			this.index = Math.max(
				0,
				Math.min(this.rows.length - 1, this.index + (kb.matches(data, "tui.select.up") ? -1 : 1)),
			);
		} else if (kb.matches(data, "tui.select.confirm")) this.rows[this.index]?.select();
		else if (kb.matches(data, "tui.media.open")) void this.rows[this.index]?.action("open");
		else if (kb.matches(data, "tui.media.inspect")) void this.rows[this.index]?.action("inspect");
		else if (kb.matches(data, "tui.media.finish")) void this.rows[this.index]?.action("finish");
		this.ui.requestRender();
	}
	render(width: number): string[] {
		const lines = [truncateToWidth(theme.fg("muted", "Media  Enter · o Open · i Inspect · f Finish"), width)];
		const start = Math.max(0, this.index - 3);
		for (let i = start; i < Math.min(this.rows.length, start + 7); i++)
			lines.push(
				truncateToWidth(
					theme.fg(i === this.index ? "accent" : "muted", `${i === this.index ? "›" : " "} ${this.rows[i].label}`),
					width,
				),
			);
		const row = this.rows[this.index];
		if (row) {
			row.setVisible(true);
			lines.push(...row.render(width));
		} else lines.push(truncateToWidth("No media", width));
		return lines;
	}
	invalidate(): void {
		this.rows[this.index]?.invalidate();
	}
	dispose(): void {
		for (const row of this.rows) row.dispose();
	}
}
