// Where the founders stepped in. Written by hand, because these are the human acts the database
// doesn't record as decisions. Keep it honest: judges ask "where did you need to step in?".
export const FOUNDERS = [
  { name: "Mateo", initial: "M", role: "Co-founder. Built the agents' setup and Scout." },
  { name: "Felix", initial: "F", role: "Co-founder. Built the foundry app, its database and tools." },
];

export const STEPPED_IN = [
  {
    what: "Built the factory",
    detail: "The seven agents, their prompts, the tools each may call and a daily budget for each. Everything after that is theirs.",
  },
  {
    what: "Set the budget",
    detail: "The funding policy: the pool, the $2.50 grant and how many companies may be alive at once. We raised it mid-run, from a $10 pool and 2 live companies to $150 and 10.",
  },
  {
    what: "Set one review rule",
    detail: "Compliance screens markets, and offers for an approved market are approved on submission. We chose that to keep the loop moving.",
  },
  {
    what: "Pressed Launch",
    detail: "One switch starts every agent's schedule and budget; End stops them all. We pressed it once, early on Nov 8.",
  },
  {
    what: "Fixed the plumbing",
    detail: "Code changes while it ran: Scout must send a verified contact route, job-application forms are dropped, and Outreach and the Closer got $10 a day. Those were fixes to the machine, not calls about a company.",
  },
];

export const NEVER =
  "We never picked a market, wrote an offer, chose a price, funded a company or killed one. Every one of those calls on this site was made by an agent, and its reason is shown next to it.";
