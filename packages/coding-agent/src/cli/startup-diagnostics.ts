import type { AgentSessionRuntimeDiagnostic } from "../core/agent-session-services.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { NotificationMessageComponent } from "../modes/interactive/components/notification-message.ts";
import { createStartupTui } from "./startup-ui.ts";

/** Present fatal startup diagnostics without starting a session or admitting work. */
export async function showStartupDiagnostics(
	settingsManager: SettingsManager,
	diagnostics: readonly AgentSessionRuntimeDiagnostic[],
): Promise<void> {
	const ui = await createStartupTui(settingsManager);
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
