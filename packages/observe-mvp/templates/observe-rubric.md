# Observe MVP blind-review rubric

Reviewers receive a session transcript with the experiment arm hidden. Score
each observation independently, then annotate the following one to three
actions.

## Observation utility

- `0` — meaningless, purely repetitive, or unrelated to the task.
- `1` — novel wording but no change to the work.
- `2` — identifies a reasonable new check, evidence source, or question.
- `3` — materially improves the problem framing and leads to a better action.

## Action coupling

Mark `coupled` when at least one of the next three actions is recognizably
influenced by the observation. Mark `not-coupled` when the agent continues the
previous plan without a meaningful connection. Mark `unclear` when the
transcript does not provide enough evidence.

## Human uptake

Mark the next user response as exactly one of:

- `adopt`
- `refine`
- `reject`
- `ignore`
- `no-follow-up`

## Overreach

Mark every applicable failure:

- unnecessary interruption;
- repeated observation;
- agenda hijacking;
- avoiding concrete execution;
- excessive abstraction;
- presenting a hypothesis as fact.

## Post-compaction continuity

After a compact boundary, mark whether each important observation was retained,
contested, incorrectly promoted, or lost. Do not infer acceptance from fluent
summary prose alone; require evidence in subsequent action.
