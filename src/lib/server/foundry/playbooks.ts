// The eight scouting playbooks. Each scheduled playbook gets its own Naïve deployment,
// whose prompt names the playbook, so a scheduled run never has to guess what to do next or know the
// time. Scout itself runs the playbook with its own tools (agents/prompts/scout.md); the cron only
// starts it. The pipelines in scout-ideas.ts are the local, deterministic version of the same sources.

export const PLAYBOOKS = ["maps", "reviews", "appstore", "jobs", "reddit", "consumer_posts", "app_wishes", "agents"] as const;
export type Playbook = (typeof PLAYBOOKS)[number];

// Scheduled every cycle: the business playbooks, whose leads carry a published email or a verified
// inquiry form that Outreach can use. The other four find consumer and agent posts that can only be
// answered with a public reply, and no social account is connected, so they run only by hand.
export const SCHEDULED_PLAYBOOKS = ["maps", "reviews", "appstore", "jobs"] as const satisfies readonly Playbook[];

const MARKER = "Playbook: ";
export function playbookPrompt(playbook: Playbook, mode: string) {
  return `${MARKER}${playbook}\nRun one bounded scouting pass in ${mode} mode using the ${playbook} playbook. Obtain the current UTC time from runtime/tool context. Return the required structured output. Never contact anyone.`;
}
export function playbookOf(inputTemplate: string): Playbook | null {
  if (!inputTemplate.startsWith(MARKER)) return null;
  const name = inputTemplate.slice(MARKER.length).split("\n", 1)[0];
  return (PLAYBOOKS as readonly string[]).includes(name) ? (name as Playbook) : null;
}

