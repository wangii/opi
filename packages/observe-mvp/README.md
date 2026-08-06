# PI Observe MVP

This package provides the isolated Observe experiment described in the MVP
design. It adds the provisional `observe` tool, the `/obs` invitation command,
an Observe-specific TUI renderer, and an optional semantic continuation-memory
compaction hook.

Run manually from the repository root:

```text
pi --extension ./packages/observe-mvp/src/index.ts --observe-arm=interaction
```

The available arms are:

- `off` — the extension is loaded but the tool and semantic compaction are disabled;
- `interaction` — the Observe tool is enabled with native compaction;
- `interaction+compact` — the Observe tool and semantic continuation-memory compaction are enabled;
- `frame-forward` — frame-conditioned semantic memory is enabled for future messages;
- `frame-adaptive` — frame-conditioned semantic memory and adaptive reframing are enabled.

For frame-memory arms, the first turn derives a concise default operating frame
from Pi's currently loaded `AGENTS.md` hierarchy. It uses the already loaded
context-file metadata and does not make a separate model request. A later
`observe` call supersedes this provisional default frame.

The experiment's authoritative baseline should run without loading this
extension at all. Session JSONL remains the source of truth; the exported
`extractObserveRecords()` helper only normalizes observation tool results for
offline analysis.
