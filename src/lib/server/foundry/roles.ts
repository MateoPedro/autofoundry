export const CREW_ROLES = ["scout", "compliance", "creator", "vc", "feedback", "outreach", "closer"] as const;

export type CrewRole = (typeof CREW_ROLES)[number];

// Daily budgets in micro-USD.
export const ROLE_BUDGETS: Record<CrewRole, { cap_micro_usd: number; max_task_micro_usd: number }> = {
  scout: { cap_micro_usd: 15_000_000, max_task_micro_usd: 500_000 },
  compliance: { cap_micro_usd: 3_000_000, max_task_micro_usd: 500_000 },
  creator: { cap_micro_usd: 2_000_000, max_task_micro_usd: 500_000 },
  vc: { cap_micro_usd: 15_000_000, max_task_micro_usd: 500_000 },
  feedback: { cap_micro_usd: 2_000_000, max_task_micro_usd: 500_000 },
  outreach: { cap_micro_usd: 5_000_000, max_task_micro_usd: 300_000 },
  closer: { cap_micro_usd: 5_000_000, max_task_micro_usd: 300_000 },
};

// Leads a company gets before funding; each extra grant adds the next batch.
export const SAMPLE_LEADS = 5;
