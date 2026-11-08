import { fund, kill, spawn } from "./company";
import { addLeads, findLead, listClusters, logTouch } from "./leads";
import { getCompany, getMetrics } from "./metrics";
import { listPending, logDecision, proposeOffer, review, reviewContext } from "./review";
import type { Tool } from "./tool";

// In the order of the contract's tool table (docs/foundry-contract.md, section 5).
export const foundryTools: Tool[] = [
  addLeads,
  listClusters,
  listPending,
  reviewContext,
  review,
  proposeOffer,
  spawn,
  fund,
  kill,
  logDecision,
  getMetrics,
  getCompany,
  logTouch,
  findLead,
];
