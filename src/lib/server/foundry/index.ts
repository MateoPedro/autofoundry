import { fund, kill, spawn } from "./company";
import { followUpsDue, publishSample } from "./crew";
import { addLeads, findLead, listClusters, logTouch } from "./leads";
import { getCompany, getMetrics } from "./metrics";
import { monidRead } from "./monid";
import { listOffers, listPending, logDecision, proposeOffer, review, reviewContext } from "./review";
import type { Tool } from "./tool";

// In the order of the contract's tool table (docs/foundry-contract.md, section 5).
export const foundryTools: Tool[] = [
  addLeads,
  listClusters,
  monidRead,
  listOffers,
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
  publishSample,
  followUpsDue,
];
