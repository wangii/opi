# Changelog

## [Unreleased]

### Added

- Inject a one-line projection metrics message next to the active frame on every
  provider request (`observe.projection-metrics`): post-frame record count,
  replaced sources, dropped pre-frame messages, and raw-to-frame token counts, so
  the agent can perceive when the frame is or is not compressing context.
- `frame-adaptive` arm now detects a frame that fails to reduce context size for
  several consecutive provider requests and injects an explicit reframe hint
  (`observe.adaptive-hint`) inviting the agent to call `observe`. The adaptive
  window restarts after a successful `observe` or a session reset.
- Observe prompt guidelines now list concrete reframe triggers (contradicting
  evidence, changed goal or constraints, non-compressing projection metrics).
- Redefined the frame: a frame is now a provisional, action-guiding task-state
  model that names the focus to observe and the reframe conditions (which
  actions or results, once they occur, require revising the frame), instead of
  a summary of repository rules.
- The default frame is now derived deterministically from the session's first
  user prompt (a normalized, bounded task anchor), not from the `AGENTS.md`
  hierarchy; repository rules stay in the system prompt via context files.

### Changed

- `ObserveState` gains `projectionNoCompressionStreak` to track consecutive
  no-compression provider requests for adaptive reframing.
- The default frame is treated as a first-class frame: the `isDefaultObserveFrame`
  special-casing was removed, so frame-conditioned semantic memory and
  pre-frame dropping apply to the prompt-derived default frame like any other
  frame.
- `DefaultObserveFrameDetails` becomes schema version 2 with a `promptAnchor`
  field; schema version 1 entries (AGENTS-derived) are still accepted during
  reconstruction for older session JSONL.

### Fixed

- Observed sessions rarely changed frames because the model could not perceive
  compression outcomes; the projection metrics injection gives the model the
  missing cost/benefit signal.
- Repeated identical reads were re-indexed (and often re-dropped), fueling the
  read → drop → re-read loop and wasting nested-request tokens; a `read` whose
  file content was already indexed under the active frame is now skipped and
  stays raw in context.
- Read sources were serialized with the same small cap as other tool results, so
  the indexer could not see frame-relevant facts in the middle of large files;
  reads now get a larger head+tail indexing view and a proportionally higher
  interpretation budget.
- Bash commands with output redirection (`echo > file`, `cat > file <<EOF`,
  pipes into `tee`) were classified as read-only exploration and could be
  dropped despite writing files; they are now treated as side-effecting.
