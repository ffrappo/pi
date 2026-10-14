import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import type { AgentSessionRuntimeDiagnostic } from "../core/agent-session-services.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { NotificationMessageComponent } from "../modes/interactive/components/notification-message.ts";

/** Present fatal startup diagnostics without starting a session or admitting work. */
export async function showStartupDiagnostics(
	settingsManager: SettingsManager,
	diagnostics: readonly AgentSessionRuntimeDiagnostic[],
): Promise<void> {
	// Startup already resolved the current theme/resources. Do not re-enter
	// the failing package/configuration discovery path just to display its error.
	const ui = new TuiMainScreen(new ProcessTerminal(), settingsManager.getShowHardwareCursor());
	for (const diagnostic of diagnostics) {
		ui.addChild(new NotificationMessageComponent(diagnostic.message, { level: diagnostic.type }));
	}
	try {
		ui.start();
		ui.renderNow();
		await ui.terminal.drainInput();
	} finally {
		ui.stop();
	}
}
