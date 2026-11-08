import type { z } from "zod";
import type { Db } from "../db";
import type { MonidReader } from "../monid";

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

// A crew session and what woke it, read from its metadata (verified Nov 8 against live sessions):
// a card wake sets metadata.board.digest to the woken card ids, and an inbound email sets
// metadata.inbound_message_id.
export type CrewSession = { id: string; created_at: string; consumed_micro_usd: number; card_ids: string[]; inbound_message_id: string | null };

// An email to the shared inbox. guard_reason is set when Naïve didn't wake the Closer for it.
export type InboundMessage = { id: string; from: string; subject: string | null; text: string; received_at: string; guard_reason: string | null };

// The Naïve calls the foundry makes with NAIVE_WRITE_KEY. Tests pass a fake.
export type NaiveWriter = {
  inboundMessages(identityId: string, inboxId: string, since: Date): Promise<InboundMessage[]>;
  sessionsSince(agentId: string, since: Date): Promise<CrewSession[]>;
  createCard(boardId: string, card: { title: string; body: string; assignee: string; key: string }): Promise<{ id: string }>;
  setBudget(agentId: string, budget: Budget): Promise<void>;
  cardsOf(agentId: string): Promise<BoardCard[]>;
  setCardStatus(boardId: string, cardId: string, status: "todo" | "done"): Promise<void>;
  findDeployment(agentId: string): Promise<{ id: string } | null>;
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
  // The foundry's public URL (FOUNDRY_URL), where samples are served at /s/<lead_id>.
  appUrl: string;
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
