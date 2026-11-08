import { fund, kill, spawn } from "./company";
import { followUpsDue, publishSample } from "./crew";
import { compactFeedback, feedbackContext, scoutMemory, writeFeedback } from "./feedback";
import { addLeads, findLead, listClusters, logTouch } from "./leads";
import { getCompany, getMetrics } from "./metrics";
import { monidRead } from "./monid";
import { checkoutLink } from "./payments";
import { screenBatch, submitScreen } from "./screen";
import { listOffers, listPending, logDecision, proposeOffer, review, reviewContext } from "./review";
import type { Tool } from "./tool";

// In the order of the contract's tool table (docs/foundry-contract.md, section 5).
export const foundryTools: Tool[] = [
  addLeads,
  listClusters,
  monidRead,
  listOffers,
  listPending,
  screenBatch,
  submitScreen,
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
  checkoutLink,
  scoutMemory,
  feedbackContext,
  writeFeedback,
  compactFeedback,
];
