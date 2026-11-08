import type { BoardCard, Budget, NaiveWriter, Team } from "../../src/lib/server/foundry/tool";

type Agent = { id: string; name: string; config: Record<string, unknown>; budget: Budget; identities: string[] };
type Card = BoardCard & { title: string; body: string; assignee: string; key: string };

// Behaves like the Naïve calls verified on Nov 8: a card assigned to a zero-cap agent is parked
// as blocked, a keyed card create answers the first card, and an inbox owner must hold the identity.
export class FakeNaive implements NaiveWriter {
  agents: Agent[] = [];
  identities: { id: string; name: string }[] = [];
  apps: { id: string; name: string; url: string | null }[] = [];
  inboxes: { id: string; identity_id: string; address: string; owner: string }[] = [];
  boards: { id: string; agent_id: string }[] = [];
  cards: Card[] = [];
  deployments: { id: string; agent_id: string; cron: string; input_template: string; identity: string; enabled: boolean }[] = [];
  deploys: { appId: string; files: Record<string, string> }[] = [];
  calls: string[] = [];
  failOn = new Map<string, Error>();
  // Simulates a call that succeeds on Naïve's side and then times out before the answer arrives.
  loseAnswerOn = new Set<string>();
  budgetReadback: Partial<Budget> | null = null;
  private n = 0;

  private next(prefix: string) {
    return `${prefix}_${++this.n}`;
  }

  private async call<T>(name: string, fn: () => T): Promise<T> {
    this.calls.push(name);
    const failure = this.failOn.get(name);
    if (failure) throw failure;
    const out = fn();
    if (this.loseAnswerOn.delete(name)) throw Object.assign(new Error("request timed out"), { status: 504 });
    return out;
  }

  agent(name: string) {
    const agent = this.agents.find((a) => a.name === name);
    if (!agent) throw new Error(`no agent ${name}`);
    return agent;
  }

  systemDomain() {
    return this.call("systemDomain", () => "auto-foundry-03s9ve.usenaive.ai");
  }

  createIdentity(body: { name: string }) {
    return this.call("createIdentity", () => {
      const identity = { id: this.next("idn"), name: body.name };
      this.identities.push(identity);
      return { id: identity.id };
    });
  }

  createApp(body: { name: string }) {
    return this.call("createApp", () => {
      const app = { id: this.next("app"), name: body.name, url: null };
      this.apps.push(app);
      return { id: app.id };
    });
  }

  deployApp(appId: string, files: Record<string, string>) {
    return this.call("deployApp", () => {
      this.deploys.push({ appId, files });
      const app = this.apps.find((a) => a.id === appId)!;
      app.url = `https://${app.name}-p2jr2103s9ve-naive-e9517ea2.vercel.app`;
      return { url: app.url };
    });
  }

  findAgent(name: string) {
    return this.call("findAgent", () => {
      const agent = this.agents.find((a) => a.name === name);
      return agent ? { id: agent.id, metadata: (agent.config.metadata ?? {}) as Record<string, unknown> } : null;
    });
  }

  createAgent(config: Record<string, unknown> & { name: string; budget: Budget }) {
    return this.call("createAgent", () => {
      if (config.budget.cap_micro_usd === 0 && config.budget.max_task_micro_usd !== 0) throw new Error("max_task_micro_usd must be 0 too");
      const agent = { id: this.next("agt"), name: config.name, config, budget: config.budget, identities: [] };
      this.agents.push(agent);
      return { id: agent.id };
    });
  }

  attachIdentity(agentId: string, identityId: string) {
    return this.call("attachIdentity", () => {
      const agent = this.agents.find((a) => a.id === agentId)!;
      if (!agent.identities.includes(identityId)) agent.identities.push(identityId);
    });
  }

  findInbox(identityId: string, address: string) {
    return this.call("findInbox", () => {
      const inbox = this.inboxes.find((i) => i.identity_id === identityId && i.address === address);
      return inbox ? { id: inbox.id } : null;
    });
  }

  createInbox(identityId: string, body: { address: string; owning_agent_id: string }) {
    return this.call("createInbox", () => {
      const owner = this.agents.find((a) => a.id === body.owning_agent_id)!;
      if (!owner.identities.includes(identityId)) throw new Error(`agent ${owner.id} does not hold identity ${identityId}; attach it first`);
      const inbox = { id: this.next("eml"), identity_id: identityId, address: body.address, owner: owner.id };
      this.inboxes.push(inbox);
      return { id: inbox.id };
    });
  }

  ensureBoard(agentId: string) {
    return this.call("ensureBoard", () => {
      let board = this.boards.find((b) => b.agent_id === agentId);
      if (!board) {
        board = { id: this.next("brd"), agent_id: agentId };
        this.boards.push(board);
      }
      return { id: board.id };
    });
  }

  createCard(boardId: string, card: { title: string; body: string; assignee: string; key: string }) {
    return this.call("createCard", () => {
      const seen = this.cards.find((c) => c.board_id === boardId && c.key === card.key);
      if (seen) return { id: seen.id };
      const parked = this.agent(card.assignee).budget.cap_micro_usd === 0;
      const made = { id: this.next("crd"), board_id: boardId, status: parked ? "blocked" : "todo", blocked_by: [], ...card };
      this.cards.push(made);
      return { id: made.id };
    });
  }

  setBudget(agentId: string, budget: Budget) {
    return this.call("setBudget", () => {
      if (budget.max_task_micro_usd > budget.cap_micro_usd) throw new Error("max_task_micro_usd may not exceed cap_micro_usd");
      this.agents.find((a) => a.id === agentId)!.budget = budget;
    });
  }

  setTeam(agentId: string, team: Team) {
    return this.call("setTeam", () => {
      this.agents.find((a) => a.id === agentId)!.config.multiagent = team;
    });
  }

  getBudget(agentId: string) {
    return this.call("getBudget", () => ({ ...this.agents.find((a) => a.id === agentId)!.budget, ...this.budgetReadback }));
  }

  cardsOf(agentId: string) {
    return this.call("cardsOf", () => {
      const name = this.agents.find((a) => a.id === agentId)!.name;
      return this.cards.filter((c) => c.assignee === name).map(({ id, board_id, status, blocked_by }) => ({ id, board_id, status, blocked_by }));
    });
  }

  setCardStatus(boardId: string, cardId: string, status: "todo" | "done") {
    return this.call("setCardStatus", () => {
      this.cards.find((c) => c.board_id === boardId && c.id === cardId)!.status = status;
    });
  }

  findDeployment(agentId: string) {
    return this.call("findDeployment", () => {
      const deployment = this.deployments.find((d) => d.agent_id === agentId);
      return deployment ? { id: deployment.id } : null;
    });
  }

  createDeployment(body: { agent_id: string; cron: string; input_template: string; identity: string }) {
    return this.call("createDeployment", () => {
      const deployment = { id: this.next("dep"), ...body, enabled: false };
      this.deployments.push(deployment);
      return { id: deployment.id };
    });
  }

  setDeploymentEnabled(deploymentId: string, enabled: boolean) {
    return this.call("setDeploymentEnabled", () => {
      this.deployments.find((d) => d.id === deploymentId)!.enabled = enabled;
    });
  }
}
