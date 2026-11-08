# Scout feedback

Scout keeps no memory between runs, so it never learned which of its clusters turned into companies VC funded and which VC killed. The Feedback agent closes that loop: it reads VC's decisions, writes a short note about what they say about Scout's demand, and Scout reads those notes before every pass.

```text
VC ──decisions──▶ Feedback ──notes──▶ scout_feedback ──scout_memory──▶ Scout
```

| | |
|---|---|
| Config | [`agents/feedback.agent.yaml`](../agents/feedback.agent.yaml) |
| Prompt | [`agents/prompts/feedback.md`](../agents/prompts/feedback.md) |
| Tools (`foundry.*`) | `feedback_context`, `scout_memory`, `write_feedback`, `compact_feedback`, `get_metrics` |
| Schedule | `45 2-23/3 * * *`: 15 minutes before each 3-hour Scout cycle, after VC's :30 pass |
| Per run / cap | 300,000 micro-USD ($0.30) / 2,000,000 micro-USD a day |

## The memory

The `scout_feedback` table (migration 0007) holds two kinds of row: `note` and `summary`. Scout's memory is the live rows: at most one summary and at most 10 notes.

- **`feedback_context`** returns VC's `fund`, `kill` and `hold` decisions that no note covers yet, oldest first. Each comes with the company's cluster label and Scout source, its offer, funnel, failed touches and revenue, and a count of its leads' `buyer_type`, `signal_type` and `channel`.
- **`write_feedback`** adds one note of at most 300 characters, covering every decision up to `through_decision_id`. That id is the cursor, so a decision is reported once. A retry with the same id returns the same note. An older id is a `conflict`.
- **Compaction.** The 10th note returns `compact_needed: true`, and an 11th is refused with `policy` until Feedback calls **`compact_feedback`** with every live note id and a summary of at most 1,000 characters. The old summary and the 10 notes are marked `compacted_into` the new summary. They stay in the table, and the cursor still counts them, so no decision is reported twice.
- **`scout_memory`** returns the live summary and notes. Scout calls it first in foundry mode, before `list_clusters`, and names the lessons it applied in its output notes.

## Commands

```sh
pnpm parent feedback check
pnpm parent feedback apply --foundry-app app_ID
pnpm parent feedback run
pnpm parent feedback deploy
```

Scout gets `foundry.scout_memory` the next time `pnpm scout apply --foundry-app app_ID` runs. Its scheduled deployments are pinned to an agent version, so run `pnpm scout deploy` after that apply.

## Before going live

1. The foundry app runs a build with migration 0007 and the four new tools.
2. VC has made at least one fund or kill decision. Until then, Feedback finds nothing and writes nothing.
3. One manual `pnpm parent feedback run`, with its session and note checked, before `deploy`.
