import { randomUUID } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AgentContent, AgentMessage } from "@earendil-works/pi-agent-core";
import { type FileEntry, loadEntriesFromFile, type SessionEntry, type SessionManager } from "../session-manager.ts";
import { MEDIA_ADMISSION_ENTRY } from "./failures.ts";
import { MEDIA_POLICY_ENTRY } from "./policy.ts";
import {
	assertMediaReference,
	MEDIA_CONTRACT,
	type MediaOperationContext,
	type MediaReferenceContent,
	type MediaService,
} from "./types.ts";

async function mapEntries(
	entries: SessionEntry[],
	transform: (ref: MediaReferenceContent) => Promise<MediaReferenceContent>,
	legacy?: (block: Extract<AgentContent, { type: "image" }>) => Promise<MediaReferenceContent>,
): Promise<SessionEntry[]> {
	const content = async (value: string | AgentContent[]) =>
		typeof value === "string"
			? value
			: Promise.all(
					value.map((block) =>
						block.type === "media_reference"
							? transform(block)
							: block.type === "image" && legacy
								? legacy(block)
								: block,
					),
				);
	const output: SessionEntry[] = [];
	const admissions = new Map<string, boolean>();
	for (const entry of entries)
		if (entry.type === "custom" && entry.customType === MEDIA_ADMISSION_ENTRY) {
			const record = entry.data as { targetId: string; resolved?: boolean };
			admissions.set(record.targetId, record.resolved === true);
		}
	if ([...admissions.values()].some((resolved) => !resolved))
		throw new Error("Media bundle/import requires explicit repair of failed media custody first");
	for (const entry of entries) {
		if (
			entry.type === "message" &&
			(entry.message.role === "user" || entry.message.role === "toolResult" || entry.message.role === "custom")
		)
			output.push({
				...entry,
				message: { ...entry.message, content: await content(entry.message.content) } as AgentMessage,
			});
		else if (entry.type === "custom_message") output.push({ ...entry, content: await content(entry.content) });
		else if (entry.type === "context_edit" && entry.replacement) {
			const value = entry.replacement.content;
			const mapped =
				typeof value === "string"
					? value
					: await Promise.all(
							value.map((block) =>
								block.type === "media_reference"
									? transform(block)
									: block.type === "image" && legacy
										? legacy(block)
										: block,
							),
						);
			if (typeof mapped === "string") output.push({ ...entry, replacement: { content: mapped } });
			else if (mapped.some((b) => b.type === "thinking" || b.type === "toolCall")) {
				if (mapped.some((b) => b.type === "image" || b.type === "media_reference"))
					throw new Error("Invalid mixed assistant/media context edit");
				output.push({
					...entry,
					replacement: {
						content: mapped.filter(
							(b): b is Extract<typeof b, { type: "text" | "thinking" | "toolCall" }> =>
								b.type === "text" || b.type === "thinking" || b.type === "toolCall",
						),
					},
				});
			} else
				output.push({
					...entry,
					replacement: {
						content: mapped.filter((b): b is AgentContent => b.type !== "thinking" && b.type !== "toolCall"),
					},
				});
		} else if (entry.type === "compaction" && entry.activeMedia)
			output.push({
				...entry,
				activeMedia: {
					schemaVersion: 1,
					inspections: await Promise.all(
						entry.activeMedia.inspections.map(async (e) => ({ ...e, reference: await transform(e.reference) })),
					),
				},
			});
		else if (entry.type === "custom" && entry.customType === MEDIA_POLICY_ENTRY) {
			const data = entry.data as { reference: MediaReferenceContent };
			assertMediaReference(data.reference);
			output.push({ ...entry, data: { ...data, reference: await transform(data.reference) } });
		} else output.push({ ...entry });
	}
	return output;
}
function operation(cwd: string, sessionId: string, signal: AbortSignal): MediaOperationContext {
	return { cwd, sessionId, signal, operationId: randomUUID(), storeId: cwd };
}

/** Explicit asset inclusion only. References and every emission/policy retain their IDs. */
export async function exportMediaBundle(
	manager: SessionManager,
	service: MediaService,
	directory: string,
	signal: AbortSignal = new AbortController().signal,
): Promise<string> {
	const target = resolve(directory),
		stage = join(dirname(target), `.media-export-${randomUUID()}.partial`);
	await mkdir(stage, { mode: 0o700 });
	const imported = new Map<string, MediaReferenceContent>();
	const transform = async (ref: MediaReferenceContent): Promise<MediaReferenceContent> => {
		assertMediaReference(ref);
		signal.throwIfAborted();
		let replacement = imported.get(ref.assetId);
		if (!replacement) {
			const file = await service.resolveOriginal(ref, operation(manager.getCwd(), manager.getSessionId(), signal));
			replacement = await service.capture(
				{ source: "path", path: file.path, ingress: "export", intent: ref.intent, blockId: ref.blockId },
				operation(stage, manager.getSessionId(), signal),
			);
			if (replacement.assetId !== ref.assetId) throw new Error(`Export original digest changed: ${ref.assetId}`);
			imported.set(ref.assetId, replacement);
		}
		return { ...ref, store: { ...replacement.store, root: target } };
	};
	try {
		const entries = await mapEntries(manager.getBranch(), transform);
		const header = { ...manager.getHeader(), type: "session", cwd: target, requiredMediaContract: MEDIA_CONTRACT };
		const file = await open(join(stage, "session.jsonl"), "wx", 0o600);
		try {
			await file.writeFile(`${[header, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
		const index = await open(join(stage, "MANIFEST.json"), "wx", 0o600);
		try {
			await index.writeFile(
				`${JSON.stringify(
					{ schemaVersion: 1, contract: MEDIA_CONTRACT, session: "session.jsonl", assets: [...imported.keys()] },
					null,
					2,
				)}\n`,
			);
			await index.sync();
		} finally {
			await index.close();
		}
		signal.throwIfAborted();
		await rename(stage, target);
		return join(target, "session.jsonl");
	} catch (error) {
		throw new Error(
			`Media bundle export failed; retained stage ${stage}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

/** Explicit copied-session conversion. Never edits the live source or invents lost originals. */
export async function externalizeLegacySession(
	source: string,
	destination: string,
	service: MediaService,
	cwd: string,
	signal: AbortSignal = new AbortController().signal,
): Promise<string> {
	const entries = loadEntriesFromFile(source),
		header = entries[0];
	if (header?.type !== "session") throw new Error("Legacy session has no header");
	const ids = new Set<string>(),
		calls = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "session") continue;
		if (ids.has(entry.id)) throw new Error(`Duplicate session entry ${entry.id}`);
		ids.add(entry.id);
		if (entry.type === "message" && entry.message.role === "assistant")
			for (const block of entry.message.content) if (block.type === "toolCall") calls.add(block.id);
		if (entry.type === "message" && entry.message.role === "toolResult" && !calls.has(entry.message.toolCallId))
			throw new Error(`Unpaired tool result ${entry.message.toolCallId}`);
	}
	const transformed = await mapEntries(
		entries.filter((e): e is SessionEntry => e.type !== "session"),
		async (ref) => {
			assertMediaReference(ref);
			return ref;
		},
		async (block) =>
			service.capture(
				{
					source: "bytes",
					data: block.data,
					mimeType: block.mimeType,
					ingress: "legacy-import",
					intent: "inspect",
				},
				operation(cwd, header.id, signal),
			),
	);
	const output: FileEntry[] = [{ ...header, version: 4, requiredMediaContract: MEDIA_CONTRACT }, ...transformed];
	const file = await open(destination, "wx", 0o600);
	try {
		await file.writeFile(`${output.map((e) => JSON.stringify(e)).join("\n")}\n`);
		await file.sync();
	} finally {
		await file.close();
	}
	return destination;
}
