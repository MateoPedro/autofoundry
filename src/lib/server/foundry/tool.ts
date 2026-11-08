import type { z } from "zod";
import type { Db } from "../db";
import type { MonidReader } from "../monid";
import type { ChildTemplate } from "./templates";

export type ToolErrorCode = "not_found" | "invalid" | "conflict" | "not_approved" | "policy" | "killed" | "stopped" | "naive_error" | "internal";

export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export type AgentSpend = { agent_id: string; agent_name: string; micro_usd: number };

export type SpendSource = { listAgentSpend(): Promise<AgentSpend[]> };

export type Budget = { cap_micro_usd: number; max_task_micro_usd: number; period: "day" | "week" | "month" };

export type BoardCard = { id: string; board_id: string; status: string; blocked_by: string[] };

export type Team = { type: "coordinator"; agents: ({ type: "self" } | { type: "agent"; id: string })[]; board: true };

// The Naïve calls spawn, fund and kill make with NAIVE_WRITE_KEY. Tests pass a fake.
export type NaiveWriter = {
  systemDomain(): Promise<string>;
  createIdentity(body: { name: string; description: string; metadata: Record<string, unknown> }): Promise<{ id: string }>;
  createApp(body: { name: string; description: string }): Promise<{ id: string }>;
  deployApp(appId: string, files: Record<string, string>): Promise<{ url: string }>;
  findAgent(name: string): Promise<{ id: string; metadata: Record<string, unknown> } | null>;
  createAgent(config: Record<string, unknown> & { name: string; budget: Budget }): Promise<{ id: string }>;
  attachIdentity(agentId: string, identityId: string): Promise<void>;
  findInbox(identityId: string, address: string): Promise<{ id: string } | null>;
  createInbox(identityId: string, body: { address: string; owning_agent_id: string }): Promise<{ id: string }>;
  ensureBoard(agentId: string): Promise<{ id: string }>;
  createCard(boardId: string, card: { title: string; body: string; assignee: string; key: string }): Promise<{ id: string }>;
  setBudget(agentId: string, budget: Budget): Promise<void>;
  setTeam(agentId: string, team: Team): Promise<void>;
  getBudget(agentId: string): Promise<Budget>;
  cardsOf(agentId: string): Promise<BoardCard[]>;
  setCardStatus(boardId: string, cardId: string, status: "todo" | "done"): Promise<void>;
  findDeployment(agentId: string): Promise<{ id: string } | null>;
  createDeployment(body: { agent_id: string; cron: string; input_template: string; identity: string }): Promise<{ id: string }>;
  setDeploymentEnabled(deploymentId: string, enabled: boolean): Promise<void>;
};

export type CheckoutRequest = {
  order_ref: string;
  lines: { name: string; unit_cents: number; quantity: number }[];
  countries: string[];
  shipping_options: { name: string; cents: number }[];
  automatic_tax: boolean;
  success_url: string;
  cancel_url: string;
  expires_at: number;
  email?: string;
};

export type Checkout = { paid: boolean; amount_cents: number; refunded_cents: number; livemode: boolean };

// Checkouts from Naïve's store on the foundry app, or from Stripe when the app holds STRIPE_SECRET_KEY. Tests pass a fake.
export type PaymentsApi = {
  source: "naive_checkout" | "stripe";
  createCheckout(body: CheckoutRequest): Promise<{ checkout_ref: string; url: string }>;
  getCheckout(ref: string): Promise<Checkout>;
};

export type ToolContext = {
  db: Db;
  spend: SpendSource | null;
  naive: NaiveWriter | null;
  payments: PaymentsApi | null;
  childTemplate: () => Promise<ChildTemplate>;
  now: () => Date;
  // Monid reads for Scout (monid_read). Absent when MONID_API_KEY isn't set on the app.
  monid?: MonidReader | null;
  monidDailyCapMicroUsd?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type Tool = {
  name: string;
  description: string;
  // A writing tool refuses while the company is stopped.
  writes: boolean;
  input: z.ZodObject;
  run(ctx: ToolContext, input: unknown): Promise<unknown>;
};

export function defineTool<S extends z.ZodObject>(tool: {
  name: string;
  description: string;
  writes: boolean;
  input: S;
  run(ctx: ToolContext, input: z.infer<S>): Promise<unknown>;
}): Tool {
  return tool as unknown as Tool;
}
