# PI Observe MVP

This package provides the isolated Observe experiment described in the MVP
design. It adds the provisional `observe` tool, the `/obs` invitation command,
an Observe-specific TUI renderer, and an optional semantic continuation-memory
compaction hook.

## Purpose

Observe is a semantic working-memory experiment, not a token-saving feature.
It investigates whether an agent can maintain a provisional interpretation of
its task, preserve evidence and contradictions under that interpretation, and
revise the interpretation when a different frame would improve subsequent
actions. The primary outcomes are task quality, evidence fidelity, retrieval,
action coupling after reframing, and continuity across long sessions and
compaction.

The raw-versus-framed token comparison is a representation constraint and an
experimental diagnostic. It prevents semantic memory from expanding without
bound; it is not the objective. Indexing, migration, and evaluation requests
may increase total generated, billed, or stored tokens even when the active
provider context is smaller.

### 中文说明

Observe 的目的不是节省 token，而是验证一种面向智能体的语义工作记忆：智能体能否围绕当前的临时任务框架保留关键证据与矛盾，在任务理解发生变化时主动重构框架，并让新的理解持续影响后续行动。项目优先关注任务完成质量、证据保真度、信息检索、重构后的行动一致性，以及长会话和上下文压缩后的任务连续性。

原始上下文与框架化上下文的 token 对比只是表示规模约束和实验诊断指标，用于防止语义记忆无限膨胀，并不代表项目以降低 token 消耗为目标。即使发送给主模型的活动上下文变小，语义索引、记忆迁移和评测仍可能增加实际生成、计费或存储的 token 总量。

## Model policy

Semantic indexing and observation have different model requirements. Indexing
primarily needs stable instruction following, structured output, and faithful
compression, so the design allows it to use an independently configured,
possibly cheaper model and reasoning level. The default remains the active
session model until that routing is implemented and evaluated.

Creating a useful observation is a reasoning-heavy task. In the current MVP,
the active session model writes the `observe` tool argument; there is no hidden
observer model. A separately configured stronger observer is a future
experiment, not an assumed optimization. Any such experiment must record the
provider, model, reasoning level, usage, and source context, and must keep model
routing fixed across compared experiment arms.

Run manually from the repository root:

```text
pi --extension ./packages/observe-mvp/src/index.ts --observe-arm=interaction
```

The available arms are:

- `off` — the extension is loaded but the tool and semantic compaction are disabled;
- `interaction` — the Observe tool is enabled with native compaction;
- `interaction+compact` — the Observe tool and semantic continuation-memory compaction are enabled;
- `frame-forward` — frame-conditioned semantic memory is enabled for future messages;
- `frame-adaptive` — frame-conditioned semantic memory and adaptive reframing are enabled (an explicit hint invites a reframe when the frame stops compressing context across consecutive requests);

For frame-memory arms, the first turn derives a default frame from the
session's first user prompt, without a separate model request. A frame is
defined as a provisional, action-guiding task-state model, not as an
instruction source: it names the focus to observe (the current goal and the
dimensions that bear on delivering it) and the reframe conditions (which
actions or results, once they occur, require revising the frame with
`observe`). Repository rules are not part of the frame; they already live in
the system prompt through context files. Before each
provider request, the active frame is injected once as an ephemeral, explicitly
provisional context message before the task history, rather than as the latest
user message or a system instruction. A later `observe` call supersedes the
provisional default frame, and the next provider request receives only the
replacement frame. Each request also receives a one-line projection metrics
message next to the frame (`post-frame records; replaced sources; dropped
pre-frame messages; raw → frame token counts`) so the agent can perceive when
the frame is or is not paying for itself; these counts exclude the system prompt
and tool schemas. In the `frame-adaptive` arm, when the frame fails to reduce
context size for several consecutive requests, an explicit hint invites the
agent to call `observe` and record a revised frame; a successful `observe`
restarts that adaptive window. In TUI mode,
the footer status line shows estimated message-context tokens as
`观 raw <before> → frame <after> tok`; these counts exclude the system prompt
and tool schemas.

The experiment's authoritative baseline should run without loading this
extension at all. Session JSONL remains the source of truth; the exported
`extractObserveRecords()` helper only normalizes observation tool results for
offline analysis.

## Semantic indexing details

Indexing serializes each unindexed message with role- and kind-aware caps:
`read` tool results get a larger head+tail view (`INDEX_READ_CAP` /
`INDEX_READ_TAIL`) so frame-relevant facts in the middle of a file are visible
to the indexer, while other tool results and tool calls stay bounded. Read
interpretations are budgeted proportionally to the source size
(`readInterpretationBudget`, capped) and validated deterministically against
that budget.

Reads are re-derivable: a `read` result whose file content was already indexed
under the active frame is skipped, so a repeated identical read stays raw in
context instead of being re-indexed (and possibly dropped) again. Bash
classification treats any output redirection (`>`, `>>`, `2>`) or a pipe into
`tee` as side-effecting, so file-writing shell forms are never droppable.
