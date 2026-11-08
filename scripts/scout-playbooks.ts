// The eight scouting playbooks Scout runs on a schedule, all of them every cycle. Each playbook gets its own Naïve deployment,
// whose prompt names the playbook, so a scheduled run never has to guess what to do next or know the
// time. Scout itself runs the playbook with its own tools (agents/prompts/scout.md); the cron only
// starts it. The pipelines in scout-ideas.ts are the local, deterministic version of the same sources.

export const PLAYBOOKS = ["maps", "reviews", "appstore", "jobs", "reddit", "consumer_posts", "app_wishes", "agents"] as const;
export type Playbook = (typeof PLAYBOOKS)[number];

// Every 3 hours all 8 playbooks run, 5 minutes apart (:00 to :35) so they don't trip Naïve's rate
// limit. One cycle is one batch of about 20 ideas for Compliance: the clusters whose leads Foundry
// saved in that 3-hour window. 64 runs a day at the verified ~191,000 micro-USD per pass is about
// $12.25, inside the 15M/day agent cap. Monid reads are billed separately and capped per day by
// the foundry app (monid_read).
export const CYCLE_HOURS = 3;
export const STAGGER_MINUTES = 5;
export function playbookCron(index: number) {
  return `${index * STAGGER_MINUTES} */${CYCLE_HOURS} * * *`;
}

const MARKER = "Playbook: ";
export function playbookPrompt(playbook: Playbook, mode: string) {
  return `${MARKER}${playbook}\nRun one bounded scouting pass in ${mode} mode using the ${playbook} playbook. Obtain the current UTC time from runtime/tool context. Return the required structured output. Never contact anyone.`;
}
export function playbookOf(inputTemplate: string): Playbook | null {
  if (!inputTemplate.startsWith(MARKER)) return null;
  const name = inputTemplate.slice(MARKER.length).split("\n", 1)[0];
  return (PLAYBOOKS as readonly string[]).includes(name) ? (name as Playbook) : null;
}

export type ExistingDeployment = { id: string; input_template: string; enabled: boolean };
// Decide what deploy changes: update the deployment already running a playbook, create the missing
// ones, and turn off any other Scout schedule (the old single generic cron). Never delete.
export function planDeployments(existing: ExistingDeployment[]) {
  const byPlaybook = new Map<Playbook, ExistingDeployment>();
  const disable: string[] = [];
  for (const d of existing) {
    const playbook = playbookOf(d.input_template);
    if (!playbook) { if (d.enabled) disable.push(d.id); continue; }
    if (byPlaybook.has(playbook)) throw new Error(`Two Scout deployments run the ${playbook} playbook (${byPlaybook.get(playbook)!.id}, ${d.id}); no schedules changed.`);
    byPlaybook.set(playbook, d);
  }
  return { upserts: PLAYBOOKS.map((playbook, i) => ({ playbook, cron: playbookCron(i), id: byPlaybook.get(playbook)?.id ?? null })), disable };
}
