# Frame-Conditioned Observe Coding Plan

## Objective

Evolve the current Observe MVP from an isolated observation event into a frame-conditioned memory experiment:

- `observe` creates a provisional frame that changes how subsequent messages are semantically recorded.
- Raw session messages remain available only as cold references for re-interpretation and audit.
- The active frame plus its semantic records must be cheaper to place in model context than the equivalent raw messages.
- A new frame may migrate historical semantic records when its estimated benefit exceeds migration cost.
- If the active frame stops compressing information, that failure becomes a bounded invitation to observe again.

This is an experimental memory architecture, not a compatibility-preserving extension of the current event schema.

## Cost Model

Keep these costs separate:

```text
C_raw_active   = tokens required to place covered raw messages in model context
C_frame_active = tokens(frame) + tokens(frame-conditioned semantic records)
C_migration    = one-time tokens/latency required to plan and perform re-indexing
```

The raw JSONL reference is cold storage and is excluded from `C_raw_active`. Including it would make total storage necessarily larger than storing raw data alone.

Two independent rules apply:

```text
A frame remains useful only while C_frame_active < C_raw_active.

Historical re-indexing is allowed only when:
expected_gain > C_migration
and projected C_frame_active < C_raw_active.
```

For the first version, expected gain may be model-estimated and biased high. Cost accounting and the post-generation compression check remain deterministic.

## MVP Boundaries

Implement:

- frame creation through `observe`;
- one semantic record per finalized message;
- forward, selective, and full migration modes;
- deterministic token accounting;
- one compression-failure review signal per frame window;
- context projection that substitutes semantic memory for covered raw context;
- session reconstruction and offline extraction;
- faux-provider tests and updated evals.

Do not implement yet:

- embeddings or a vector database;
- calibrated utility prediction;
- automatic repeated `observe` calls;
- destructive rewriting of session JSONL;
- cross-session frame sharing;
- background workers;
- a complex frame-management TUI.

## Proposed Experiment Arms

Keep the existing arms for comparison and add two isolated arms:

- `off`: no Observe behavior.
- `interaction`: current Observe event only.
- `interaction+compact`: current Observe plus semantic compaction.
- `frame-forward`: frame-conditioned records, but new frames affect only future messages.
- `frame-adaptive`: frame-conditioned records, migration planning, and compression-failure review.

Do not enable frame-conditioned memory implicitly for the existing arms. This preserves causal attribution between interaction, compaction, and continuous memory behavior.

## Data Model

Add the following versioned records to `src/types.ts`.

### Frame

```ts
interface ObserveFrame {
  schemaVersion: 2;
  frameId: string;
  observationEventId: string;
  parentFrameId?: string;
  content: string;
  createdAt: number;
  activationSourceRef?: string;
  frameTokens: number;
  status: "active" | "superseded";
}
```

The successful `observe` tool result must contain the frame content directly. State restoration must not depend on finding the original assistant tool-call arguments.

### Raw source reference

```ts
interface SourceReference {
  sourceId: string;
  entryId?: string;
  role: "user" | "assistant" | "toolResult" | "custom";
  timestamp: number;
  contentHash: string;
  rawTokens: number;
}
```

Use a stable hash over normalized role, timestamp, and content. Resolve and store `entryId` whenever the lifecycle hook runs after persistence. The hash is the fallback identifier.

### Semantic record

```ts
interface SemanticRecord {
  schemaVersion: 1;
  recordId: string;
  frameId: string;
  sourceRefs: SourceReference[];
  interpretation: string;
  semanticTokens: number;
  createdAt: number;
  migrationId?: string;
}
```

Each finalized message gets a record, but context replacement must operate on safe message groups so assistant tool calls are never separated from their tool results.

### Migration

```ts
interface ReindexPlan {
  schemaVersion: 1;
  migrationId: string;
  fromFrameId?: string;
  toFrameId: string;
  mode: "forward" | "selective" | "full";
  affectedSourceIds: string[];
  expectedGain: number;
  estimatedCost: number;
  rationale: string;
}

interface ReindexResult {
  plan: ReindexPlan;
  committed: boolean;
  actualCost: number;
  rawTokens: number;
  semanticTokens: number;
  rejectionReason?: "gain-below-cost" | "no-compression" | "generation-failed";
}
```

### Compression failure

```ts
interface FrameReviewSignal {
  schemaVersion: 1;
  frameId: string;
  rawTokens: number;
  framedTokens: number;
  sourceCount: number;
  createdAt: number;
  reason: "no-active-compression";
}
```

Persist semantic records, migrations, and review signals with `pi.appendEntry()`. They should not enter LLM context automatically.

## File-Level Implementation Plan

### 1. Repair the current package baseline

Files:

- `vitest.config.ts`
- `src/compact-hook.ts`
- `test/observe-mvp.test.ts`

Changes:

1. Change the package-local Vitest include to `test/**/*.test.ts` so `npm test` works from this directory.
2. Pass `event.customInstructions` into semantic compaction instead of silently discarding manual `/compact` focus.
3. Add regression tests for both issues before frame-memory work begins.

Exit condition:

- package tests are discovered and pass;
- manual compaction instructions appear in the generated continuation-memory request.

### 2. Add frame state and branch-aware reconstruction

New files:

- `src/frame-state.ts`
- `src/source-reference.ts`

Modify:

- `src/types.ts`
- `src/observe-tool.ts`
- `src/index.ts`

Changes:

1. Replace the current boolean-only observation state with a reducer-style state containing:
   - active frame;
   - known frames;
   - semantic records by source ID;
   - latest migration;
   - cost window;
   - whether a review signal has already fired for the active frame.
2. On successful `observe`, create and persist an `ObserveFrame` in tool-result details.
3. On `session_start`, reconstruct state from `ctx.sessionManager.getBranch()`, not all session entries, so tree branches restore independently.
4. Reset transient run/turn fields on lifecycle events without discarding reconstructed frame state.
5. Supersede the previous frame only after the new frame has been persisted successfully.

Exit condition:

- reload and branch reconstruction produce the same active frame and semantic index;
- a frame can be reconstructed without its assistant tool-call arguments.

### 3. Update the Observe tool contract and prompt

File:

- `src/observe-tool.ts`

Add explicit guidance:

> An observation should introduce a concise frame expected to make preserving and retrieving task-relevant information cheaper than retaining equivalent raw context. Do not copy evidence already available through source references. Use observe when the active frame no longer compresses a meaningful information window. After observing, continue with one bounded action influenced by the new frame.

Keep the existing semantic trigger: a materially different reading must change the next one to three actions.

The combined trigger becomes:

1. a materially different reading changes near-term action; or
2. the current frame has lost its ability to economically organize information.

Do not let the tool automatically call itself. Duplicate-per-turn protection remains.

Exit condition:

- prompt metadata names `observe` explicitly;
- frame concision and compression failure are both represented in description and guidelines.

### 4. Implement incremental frame-conditioned indexing

New file:

- `src/semantic-index.ts`

Modify:

- `src/index.ts`

Lifecycle strategy:

1. Do not append semantic entries directly from `message_end`; Pi emits that extension event before persisting the message entry.
2. At `turn_start`, `turn_end`, and `agent_settled`, scan the active branch after the previous indexing cursor.
3. Select newly persisted message entries and derive stable source references.
4. Batch messages from the same lifecycle boundary into one nested model request, while requiring one output record per source message.
5. Validate the structured response. If generation fails or output does not map exactly to selected sources, leave those messages raw and retry only at the next bounded lifecycle point.
6. Persist accepted records with `pi.appendEntry("observe.semantic-record", record)`.
7. Track nested request usage inside record metadata and experiment output, since custom entries do not automatically contribute nested usage to session totals.

Indexing prompt requirements:

- interpret under the active frame;
- preserve contradictions and evidence that pressure the frame;
- avoid repeating raw wording;
- produce the minimum continuation-relevant interpretation;
- keep hypotheses provisional;
- never invent a source reference.

No active frame means no semantic indexing.

Exit condition:

- each finalized source message receives at most one semantic record per frame version;
- duplicate lifecycle scans are idempotent;
- failures do not remove raw context.

### 5. Implement safe context projection

New file:

- `src/context-projection.ts`

Modify:

- `src/index.ts`

Use the `context` event to construct the model-facing memory:

1. Identify raw messages covered by committed semantic records.
2. Group messages into safe replacement units:
   - a user message may stand alone;
   - an assistant tool-call message and all corresponding tool results are atomic;
   - never leave an orphan tool call or tool result.
3. Replace only complete covered units.
4. Insert one compact custom context message containing:
   - active frame;
   - selected semantic records in source order;
   - unresolved contradictions;
   - raw source IDs, not raw content.
5. Keep recent unindexed messages unchanged.
6. If projection validation fails, return the original context unchanged.

The session JSONL remains untouched; only the provider-facing context is transformed.

Exit condition:

- projected context is cheaper than the covered raw context;
- tool-call/result integrity is preserved for every provider request;
- disabling the frame arm restores native context exactly.

### 6. Add migration planning and re-indexing

New file:

- `src/reindex.ts`

Modify:

- `src/observe-tool.ts`
- `src/frame-state.ts`

When a new frame is created in `frame-adaptive`:

1. Collect the previous frame, semantic records, and referenced raw messages.
2. Ask the active model for a bounded `ReindexPlan` with `forward`, `selective`, or `full` mode.
3. Validate affected source IDs against the active branch.
4. Estimate migration cost before generation.
5. Downgrade to `forward` when estimated gain does not exceed estimated cost.
6. For selective/full plans, generate candidate records under the new frame without replacing old records yet.
7. Compute actual candidate semantic tokens.
8. Commit the migration only when candidate frame plus semantic records are cheaper than equivalent raw active context.
9. Persist a `ReindexResult`, including rejected attempts.
10. Use copy-on-write versioning: old records remain available but context projection selects the latest committed record for each source.

For the first version, allow the same model that proposed the frame to estimate gain. Do not add a separate judge yet.

Exit condition:

- forward migration never touches historical records;
- selective migration touches only validated sources;
- full migration covers all eligible indexed sources on the active branch;
- failed or non-compressing migrations leave the old index active.

### 7. Add deterministic compression-failure triggering

New file:

- `src/frame-cost.ts`

Modify:

- `src/index.ts`
- `src/types.ts`

Use exported `estimateTokens()` over real or synthetic `AgentMessage` objects.

For the active frame window, calculate:

```text
rawTokens = sum(raw source message tokens)
framedTokens = frame tokens + sum(active semantic record tokens)
```

First-version trigger:

```text
(sourceCount >= 3 || rawTokens >= 512)
and framedTokens >= rawTokens
and no review signal has fired for this frame window
```

On failure:

1. Persist `observe.frame-review` with the measured values.
2. Mark a review invitation pending.
3. Inject one concise custom context signal on the next model call:
   - the active frame is no longer compressing its source window;
   - call `observe` only if a materially different frame would improve the next actions or memory economy.
4. Do not automatically invoke the tool.
5. Clear the pending signal after delivery.
6. Reset the cost window and review latch only when a new frame becomes active or the implementation deliberately starts a new measurement epoch.

Exit condition:

- short messages do not create an observe loop;
- one frame produces at most one pending review signal per measurement epoch;
- the measured trigger is persisted for offline analysis.

### 8. Integrate frame memory with semantic compaction

File:

- `src/compact-hook.ts`

Changes:

1. Include active frame, committed semantic records, migration state, and unresolved compression failure in the continuation-memory prompt.
2. Preserve `event.customInstructions`.
3. Prefer frame-conditioned records over re-serializing covered raw messages.
4. Keep uncovered recent messages in the compaction input.
5. Extend compaction details with:
   - active frame ID;
   - committed semantic record IDs;
   - migration IDs;
   - review signal IDs;
   - existing file operation lists.
6. On compaction failure, retain native compaction fallback.

Exit condition:

- continuation memory preserves the active frame as provisional;
- a contested or compression-failed frame is not promoted to fact;
- repeated compaction can reconstruct cumulative frame state.

### 9. Extend extraction and reporting

Files:

- `src/session-extractor.ts`
- `src/cli.ts`
- `templates/observe-report.md`
- `templates/observe-rubric.md`

Add extraction for:

- frames and parent-frame transitions;
- semantic records and source coverage;
- migration plans/results;
- compression ratios;
- compression-failure review signals;
- post-observe next actions;
- compaction continuity.

The CLI output should remain JSON and include schema versioning. Malformed individual JSONL lines should report line-numbered extraction errors or be skipped in an explicitly lenient mode; they should not silently corrupt frame relationships.

Report metrics:

```text
frame count
frame lifetime
raw active tokens
framed active tokens
compression ratio
migration attempts / commits
migration token cost
compression-failure count
observe calls after compression failure
action coupling after frame changes
```

Exit condition:

- every persisted frame/index/migration record is recoverable offline;
- reports can distinguish forward-only and migrated histories.

### 10. Replace smoke-only evals with discriminating evals

Files:

- `../evals/src/observe-mvp.eval.ts`
- `../evals/src/pi-harness.ts`
- `../evals/fixtures/observe/tasks.json`
- `../evals/fixtures/observe/**`

Changes:

1. Load task definitions from `tasks.json`; remove duplicated hard-coded task metadata.
2. Add harness compaction settings so compact scenarios are guaranteed to be compactable.
3. Ensure the baseline does not load the Observe extension or request an unavailable `observe` tool.
4. Export frame records, semantic records, migration results, and token accounting from each run.
5. Replace the current non-empty-response judge with checks for:
   - task success;
   - valid frame creation;
   - action coupling;
   - semantic source coverage;
   - active compression ratio below 1;
   - justified migration behavior;
   - continuity after compaction;
   - absence of repeated observe loops.
6. Compare at least `interaction`, `frame-forward`, and `frame-adaptive` against baseline.
7. Keep all coding-agent tests on the faux provider; do not use real API keys or paid tokens.

Exit condition:

- a response containing arbitrary non-empty text can no longer receive full credit;
- the long-context task performs an actual compaction;
- eval output supports the report template without manual session parsing.

## Test Plan

### Unit tests

Add focused tests under `test/` for:

- frame reconstruction from the active branch;
- stable source IDs and entry-ID resolution;
- idempotent lifecycle scans;
- semantic record validation;
- token accounting;
- no trigger below minimum window size;
- compression failure at ratio `>= 1`;
- one review signal per epoch;
- forward/selective/full source selection;
- migration rejection when gain is below cost;
- migration rejection when generated records do not compress;
- context projection preserving tool-call/result atomicity;
- fallback to raw context on projection failure;
- custom compaction instructions;
- extraction of every new record type.

### Integration tests

Use an in-memory `AgentSession`, a faux provider, and the extension factory to verify:

1. user message -> active frame -> semantic record;
2. tool-call turn -> atomic semantic projection;
3. new frame -> forward migration;
4. new frame -> selective/full committed migration;
5. compression failure -> one pending invitation -> optional observe;
6. reload/fork -> branch-correct frame restoration;
7. semantic compaction -> frame continuity.

Do not use a real provider.

### Commands

After each test-file change, run that specific Vitest file from this package. After implementation changes:

```bash
npm run check
```

Do not run `npm run build` or the full Vitest suite unless explicitly requested.

## Implementation Order

Use this order to keep each step reviewable:

1. Baseline test/config fixes.
2. Frame schema and reconstruction.
3. Observe prompt and frame creation.
4. Incremental semantic records without context replacement.
5. Token accounting and offline metrics.
6. Safe context projection.
7. Forward migration.
8. Selective/full migration.
9. Compression-failure invitation.
10. Compaction integration.
11. Extractor/report updates.
12. Eval replacement.

Do not combine phases 4–9 into one patch. The semantic index must be observable and testable before it is allowed to replace raw provider context.

## MVP Acceptance Criteria

The first usable version is complete when all of the following hold:

- Calling `observe` creates a concise, persisted active frame.
- Every subsequently finalized message is represented by at most one active semantic record.
- Provider context can use those records instead of covered raw messages without breaking tool-call structure.
- The measured active representation is smaller than equivalent raw context.
- A new frame can choose forward, selective, or full migration.
- Migration is copy-on-write and rejected when it fails the cost rules.
- A non-compressing frame emits one bounded review invitation rather than an automatic loop.
- Raw messages remain resolvable through source references but are not required in active context.
- Reload, branching, and compaction preserve frame state.
- Tests run locally from `packages/observe-mvp` and use no real provider.
- Evals measure frame utility and cost rather than response non-emptiness.
