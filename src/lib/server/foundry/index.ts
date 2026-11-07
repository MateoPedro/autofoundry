import { addLeads, findLead, listClusters, logTouch } from "./leads";
import type { Tool } from "./tool";

// In the order of the contract's tool table (docs/foundry-contract.md, section 5).
export const foundryTools: Tool[] = [addLeads, listClusters, logTouch, findLead];
