# Native media references

Implemented source contract: `pi.media.v1`. Provider `pi-ai.Message` is unchanged. `pi-agent-core.AgentContent` supports declaration merging via `CustomAgentContent`; coding-agent registers `MediaReferenceContent` there. User, custom and tool-result content can contain references. Unknown custom blocks fail conversion.

## Registration

Supply `mediaService` to `createAgentSession`, or call `pi.registerMediaService(service)` in the extension factory. Registration performs no I/O. Competing owners fail. The returned deregistration function is idempotent. `pi.mediaCapabilities` is the literal version identifier. `ctx.media` and `session.media` expose the owning handle; missing service blocks dependent media operations, not text-only sessions. Register at each extension load, not each message. Core awaits session cleanup during runtime replacement and reload.

The project service owns capture, metadata, verified original resolution and inspection derivatives. Its `describe` must read only validated metadata. Capture receives a tagged original path or owned base64 bytes, ingress and explicit intent. Context carries cwd, store/session/operation identity, AbortSignal and available tool/source IDs. Capture runs before lossy read resize and tool-result hooks. Legacy programmatic structured results retain their data transiently; transcript content is reference-only.

`prepareInspection` receives the physical resolved model and declared mode, crop or video interval. Its lease reports derivative lineage, actual frame coverage and image blocks. Video coverage must disclose audio not inspected. `preparePreview` is optional, is distinct from inspection and must return a bounded derivative with release. Core validates display bounds. Image preview without a service preview method delegates the public bounded `prepareImagePreview`; service preview failure never falls back.

## Actions and input

- `session.media.capture(input, signal?)` stages a durable reference without sending a request.
- `session.prompt(text, {media: refs})` submits explicit reference intents. Legacy `images` retains inspect intent and is captured before queueing.
- `session.steer(text, images?, {source?,media?})` and `followUp` retain references. `clearQueue()` returns refs in `media` alongside existing text arrays.
- `describe`, `preview` and `resolveOriginal` are data/preparation actions. View actions never activate model inspection.
- `open` verifies the original and uses macOS `execFile('/usr/bin/open', ['-a', 'Preview'|'QuickTime Player', path])`. Unsupported platforms fail with the verified path. Launch acceptance is not visual verification.
- `inspect(ref,{reason,mode,prompt,crop,interval})` opens a new stable inspection/block identity. While streaming, policy-only evidence is projected after finalized tool results, never inserted inside tool pairing. Idle inspection appends a new reference-bearing user entry.
- `finish(id,reason,observation?)` synchronously invalidates the old request/warmer then commits the authoritative branch close before reconciling context edits. Text observations remain available. Mixed text/tool results are retained.
- `retryAdmission()` is explicit recovery after a failed capture. Failed producer bytes remain in durable private failed custody, keyed by block/tool with full digest. Branch admission records stop requests after resume or compaction. Retry recaptures the same emission and context-edits its original target, preserving tool identity/error/usage; it does not invent user input. It does not reissue a paid producer.

RPC `get_state` advertises mediaCapabilities. Prompt, steer and follow_up accept media. Media list/capture/describe/open/inspect/finish commands expose the same handle.

Codemode `media(ref)` emits view-only evidence. `image(ref)` emits inspect evidence, including the `mediaReference` returned alongside the legacy `read` structured image. Only outer emitted evidence participates in the transcript. Byte-form image() remains inspect. No automatic remote fetch.

## History and requests

New headers are schema4; reference-bearing files declare requiredMediaContract. Unsupported future schemas/contracts fail. New history content does not contain original base64. Existing legacy histories are not rewritten on load.

`convertToLlm` is a synchronous metadata projection for routing, estimates and compaction. Actual requests hydrate after extension context transforms and physical model resolution, with an AbortSignal. Inspection leases are request-local, released at invalidation/settlement/reload. Active count and encoded-byte admission occurs before cache warming. Final serialized payload admission runs after extension provider payload transforms, honoring declared full request limits and local aggregate evidence limits. A capture failure stops the next provider request while retaining tool error, usage and structured producer output.

Native and boundary-draft compaction use the same `SessionManager.appendCompaction` checkpoint. `activeMedia` is part of the single compaction JSONL entry; no later append is needed for retention. Full active-branch policy replay masks closed evidence and avoids duplicate kept blocks. Branch extraction preserves IDs and store locators; cross-project references remain explicit external-store identities, not reinterpreted paths.

## Portability

Ordinary JSONL exports retain references and required contract. HTML renders reference descriptors and labels unresolved originals; it never uploads local media. Legacy image rasters load only when their `<details>` expands.

`exportMediaBundle(manager, service, directory, signal?)` explicitly includes verified originals in a staged private project store, checks full digests, preserves entry/block/inspection IDs and policy, then publishes one bundle. Failed stages are retained and named in the error. `externalizeLegacySession(source,destination,service,cwd,signal?)` converts a copied session, validates every physical JSON line, schema/contract and entry/tool identity, and never rewrites the live source. Malformed or truncated JSON fails before capture or output publication; valid input without a final newline remains unchanged. The service owns relocation/store binding.

## Acceptance scope

Source typecheck is separate from actual provider, native open, UI, performance or inspection quality. No feature release or installed runtime modification is authorized by this implementation. The source tree remains v1.0.4 development; adoption requires an upstream release carrying this contract.
