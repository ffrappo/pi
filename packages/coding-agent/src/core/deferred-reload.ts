export class DeferredReload {
	private pending = false;
	private running = false;
	private stopped = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly ready: () => boolean;
	private readonly reload: () => Promise<void>;
	private readonly failed: (error: unknown) => void;
	constructor(ready: () => boolean, reload: () => Promise<void>, failed: (error: unknown) => void) {
		this.ready = ready;
		this.reload = reload;
		this.failed = failed;
	}
	request(): void {
		if (this.stopped || this.running) return;
		this.pending = true;
		this.schedule();
	}
	private schedule(): void {
		if (this.timer || this.stopped) return;
		// A macrotask allows the requesting lifecycle dispatch to return first.
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.drain();
		}, 100);
		this.timer.unref();
	}
	private async drain(): Promise<void> {
		if (!this.pending || this.stopped || this.running) return;
		if (!this.ready()) {
			this.schedule();
			return;
		}
		this.pending = false;
		this.running = true;
		try {
			await this.reload();
		} catch (error) {
			this.failed(error);
		} finally {
			this.running = false;
		}
	}
	cancel(): void {
		this.pending = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
	dispose(): void {
		this.stopped = true;
		this.pending = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
