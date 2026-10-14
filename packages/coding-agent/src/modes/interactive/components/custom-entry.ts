import type { Component } from "@earendil-works/pi-tui";
import { Container, Spacer } from "@earendil-works/pi-tui";
import type { EntryRenderer } from "../../../core/extensions/types.ts";
import type { CustomEntry } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.ts";
import { NotificationMessageComponent } from "./notification-message.ts";

/**
 * Component that renders a custom session entry from extensions.
 * The host owns transcript spacing; renderer output should provide only its content.
 */
export class CustomEntryComponent extends Container {
	private entry: CustomEntry<unknown>;
	private renderer: EntryRenderer;
	private customComponent?: Component;
	private rendererError?: string;
	private _expanded = false;
	private outputPad: number;

	constructor(entry: CustomEntry<unknown>, renderer: EntryRenderer, outputPad = 1) {
		super();
		this.entry = entry;
		this.renderer = renderer;
		this.outputPad = outputPad;
		this.rebuild();
	}

	hasContent(): boolean {
		return this.customComponent !== undefined;
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
		this.rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	override render(width: number): string[] {
		try {
			return super.render(width);
		} catch (error) {
			if (this.rendererError !== undefined) throw error;
			this.rendererError = error instanceof Error ? error.message : String(error);
			this.rebuild();
			return super.render(width);
		}
	}

	private rebuild(): void {
		this.clear();
		this.customComponent = undefined;

		let component: Component | undefined;
		if (this.rendererError === undefined) {
			try {
				component = this.renderer(this.entry, { expanded: this._expanded }, theme);
			} catch (error) {
				this.rendererError = error instanceof Error ? error.message : String(error);
			}
		}
		if (this.rendererError !== undefined) {
			component = new NotificationMessageComponent(
				`[${this.entry.customType}] renderer failed: ${this.rendererError}`,
				{
					level: "error",
					paddingX: this.outputPad,
				},
			);
		}

		if (!component) {
			return;
		}

		this.customComponent = component;
		this.addChild(new Spacer(1));
		this.addChild(component);
	}
}
