// The eight scouting playbooks Scout runs on a schedule. Each playbook gets its own Naïve deployment,
// whose prompt names the playbook, so a scheduled run never has to guess what to do next or know the
// time. Scout itself runs the playbook with its own tools (agents/prompts/scout.md); the cron only
// starts it. The pipelines in scout-ideas.ts are the local, deterministic version of the same sources.

export const PLAYBOOKS = ["maps", "reviews", "appstore", "jobs", "reddit", "consumer_posts", "app_wishes", "agents"] as const;
export type Playbook = (typeof PLAYBOOKS)[number];

// One Scout run every 3 hours, so each of the 8 playbooks runs once a day: 8 runs a day, about
// $1.06 at the verified ~132,000 micro-USD per pass, well inside the 3M/day agent cap. Monid reads
// are billed separately and capped per day by the foundry app (monid_read).
export const STAGGER_MINUTES = 180;
export function playbookCron(index: number) {
  const offset = index * STAGGER_MINUTES;
  return `${offset % 60} ${Math.floor(offset / 60)} * * *`;
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
