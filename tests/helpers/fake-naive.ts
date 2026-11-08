import type { BoardCard, Budget, CrewSession, NaiveWriter } from "../../src/lib/server/foundry/tool";

type Agent = { id: string; name: string; budget: Budget; board_id: string };
type Card = BoardCard & { title: string; body: string; assignee: string; key: string };

// Behaves like the Naïve calls verified on Nov 8: a card assigned to a zero-cap agent is parked
// as blocked, and a keyed card create answers the first card.
export class FakeNaive implements NaiveWriter {
  agents: Agent[] = [];
  cards: Card[] = [];
  deployments: { id: string; agent_id: string; enabled: boolean }[] = [];
  sessions: (CrewSession & { agent_id: string })[] = [];
  calls: string[] = [];
  failOn = new Map<string, Error>();
  private n = 0;

  private next(prefix: string) {
    return `${prefix}_${++this.n}`;
  }

  private async call<T>(name: string, fn: () => T): Promise<T> {
    this.calls.push(name);
    const failure = this.failOn.get(name);
    if (failure) throw failure;
    return fn();
  }

  // Test setup, not a Naïve call: an agent that already exists, with its board.
  addAgent(name: string, budget: Budget) {
    const agent = { id: this.next("agt"), name, budget, board_id: this.next("brd") };
    this.agents.push(agent);
    return agent;
  }

  // Test setup: a session Naïve ran for one crew agent.
  addSession(agentName: string, session: CrewSession) {
    const row = { ...session, agent_id: this.agent(agentName).id };
    this.sessions.push(row);
    return row;
  }

  agent(name: string) {
    const agent = this.agents.find((a) => a.name === name);
    if (!agent) throw new Error(`no agent ${name}`);
    return agent;
  }

  sessionsSince(agentId: string, since: Date) {
    return this.call("sessionsSince", () =>
      this.sessions
        .filter((s) => s.agent_id === agentId && Date.parse(s.created_at) >= since.getTime())
        .map((s) => ({ id: s.id, created_at: s.created_at, consumed_micro_usd: s.consumed_micro_usd, card_ids: s.card_ids, inbound_message_id: s.inbound_message_id })),
    );
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

  setDeploymentEnabled(deploymentId: string, enabled: boolean) {
    return this.call("setDeploymentEnabled", () => {
      this.deployments.find((d) => d.id === deploymentId)!.enabled = enabled;
    });
  }
}
