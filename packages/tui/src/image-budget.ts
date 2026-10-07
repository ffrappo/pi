const LIMIT = 8 * 1024 * 1024;
interface Entry {
	bytes: number;
	evict?: () => void;
}
const entries = new Map<object, Entry>();
let retained = 0;
/** Shared accounting for conversion cache and mounted components, including render strings. */
export function reserveImageBytes(owner: object, bytes: number, evict?: () => void): void {
	if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid image byte reservation");
	const old = entries.get(owner)?.bytes ?? 0;
	for (const [key, entry] of entries) {
		if (retained - old + bytes <= LIMIT) break;
		if (key === owner || !entry.evict) continue;
		entries.delete(key);
		retained -= entry.bytes;
		entry.evict();
	}
	if (retained - old + bytes > LIMIT)
		throw new Error(`Display image byte budget exceeded (${retained - old + bytes}/${LIMIT})`);
	entries.delete(owner);
	entries.set(owner, { bytes, evict });
	retained += bytes - old;
}
export function releaseImageBytes(owner: object): void {
	const entry = entries.get(owner);
	if (entry) {
		retained -= entry.bytes;
		entries.delete(owner);
	}
}
export function getImageByteUsage(): { retainedBytes: number; limitBytes: number; owners: number } {
	return { retainedBytes: retained, limitBytes: LIMIT, owners: entries.size };
}
