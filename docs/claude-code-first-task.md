# Claude Code's first task: review the Naïve integration boundary

## Context

The user asked Codex and Claude Code to work together on AutoFoundry. The initial repository is a tested Next.js demo. No provider integration is implemented. Codex is coordinating; this is Claude Code's first independent review.

## Task

Read `AGENTS.md`, `README.md`, `docs/mvp-plan.md`, `src/lib/studio.ts`, `src/app/page.tsx`, and the existing tests. Review the current structure and propose the smallest real Naïve-backed company workflow that the dashboard can launch and observe.

Use the official Naïve docs at https://usenaive.ai/docs to verify the current SDK and API contract when web access is available. The documented TypeScript managed-agents package is `@usenaive-sdk/managed-agents`; verify current details before coding. Mark anything you cannot verify rather than inventing methods.

The intended provider boundaries are:
- Naïve runs the agent team and sessions, budgets, and execution events.
- Monid supplies external research/data tools.
- AgentMail supplies the customer inbox and email conversations.
- Mobilerun performs a mobile-app step and returns its result to Naïve.
- AutoFoundry owns the portfolio records, company playbooks, dashboard, and allocation policy.

## Return to Codex

1. Material issues in the starter that could block integration, with file references.
2. A proposed company → Naïve agent/team/session data mapping and state transitions.
3. Proposed server routes and persistence requirements, including budget units, retry/idempotency behavior, and what stop does to active work.
4. One small implementation task Claude Code can own, with specific file boundaries and acceptance criteria.
5. Missing credentials or decisions. List variable names only; never print or request secret values in the review.

Do not edit files, commit, push, spend provider credits, create accounts/resources, or send/publish messages for this review. Read-only documentation research is allowed. Keep the response focused on a two-person hackathon MVP.
