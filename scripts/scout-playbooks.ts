import { SCHEDULED_PLAYBOOKS, playbookOf, playbookPrompt, type Playbook } from "../src/lib/server/foundry/playbooks";
import { RUN_BUDGET_MICRO_USD } from "./scout-config";

export { PLAYBOOKS, SCHEDULED_PLAYBOOKS, playbookOf, playbookPrompt, type Playbook } from "../src/lib/server/foundry/playbooks";

// Every 2 hours the scheduled playbooks run, 5 minutes apart (:00 to :15) so they don't trip Naïve's
// rate limit. One cycle is one batch of ideas for Compliance: the clusters whose leads Foundry saved
// in that 2-hour window. 48 runs a day at the verified ~191,000 micro-USD per pass is about $9.17,
// inside the 15M/day agent cap. Monid reads are billed separately and capped per day by
// the foundry app (monid_read).
export const CYCLE_HOURS = 2;
export const STAGGER_MINUTES = 5;
export function playbookCron(index: number) {
  return `${index * STAGGER_MINUTES} */${CYCLE_HOURS} * * *`;
}

export type ExistingDeployment = { id: string; input_template: string; enabled: boolean };
// Decide what deploy changes: update the deployment already running a scheduled playbook, create the
// missing ones, and turn off any other Scout schedule: a paused playbook or the old generic cron.
// Never delete.
export function planDeployments(existing: ExistingDeployment[]) {
  const byPlaybook = new Map<Playbook, ExistingDeployment>();
  const disable: string[] = [];
  for (const d of existing) {
    const playbook = playbookOf(d.input_template);
    if (!playbook || !(SCHEDULED_PLAYBOOKS as readonly Playbook[]).includes(playbook)) { if (d.enabled) disable.push(d.id); continue; }
    if (byPlaybook.has(playbook)) throw new Error(`Two Scout deployments run the ${playbook} playbook (${byPlaybook.get(playbook)!.id}, ${d.id}); no schedules changed.`);
    byPlaybook.set(playbook, d);
  }
  return { upserts: SCHEDULED_PLAYBOOKS.map((playbook, i) => ({ playbook, cron: playbookCron(i), id: byPlaybook.get(playbook)?.id ?? null })), disable };
}

// Schedules are created off; Launch turns them on and End turns them off.
export function playbookDeployment(agent: { id: string; current_version: number }, playbook: Playbook, cron: string, mode: string, onIdle: string) {
  return { agent_id: agent.id, agent_version: agent.current_version, cron, timezone: "UTC", window: "loose" as const,
    budget_micro_usd: RUN_BUDGET_MICRO_USD, input_template: playbookPrompt(playbook, mode), enabled: false, on_idle: onIdle };
}
