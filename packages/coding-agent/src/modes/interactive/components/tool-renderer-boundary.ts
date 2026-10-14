import { type Component, Container } from "@earendil-works/pi-tui";
import { NotificationMessageComponent } from "./notification-message.ts";

/** Keep renderer failure visible alongside the original tool data. Never change execution status. */
export class ToolRendererBoundary extends Container {
	private readonly label: string;
	private readonly original: () => Component | undefined;
	private readonly onFailure: (error: unknown) => void;
	private failed = false;

	constructor(
		label: string,
		create: () => Component,
		original: () => Component | undefined,
		onFailure: (error: unknown) => void,
	) {
		super();
		this.label = label;
		this.original = original;
		this.onFailure = onFailure;
		try {
			this.addChild(create());
		} catch (error) {
			this.report(error);
		}
	}

	override render(width: number): string[] {
		try {
			return super.render(width);
		} catch (error) {
			if (this.failed) throw error;
			this.report(error);
			return super.render(width);
		}
	}

	private report(error: unknown): void {
		this.failed = true;
		this.onFailure(error);
		this.clear();
		const message = error instanceof Error ? error.message : String(error);
		this.addChild(new NotificationMessageComponent(`${this.label} renderer failed: ${message}`, { level: "error" }));
		const original = this.original();
		if (original) this.addChild(original);
	}
}
