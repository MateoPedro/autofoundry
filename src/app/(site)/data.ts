import { cache } from "react";
import { agentProfiles, loadSite } from "@/lib/server/site";

// One database read per request, shared by the layout (nav, ticker) and the page.
export const getSite = cache(() => loadSite());
export const getProfiles = cache(() => agentProfiles());
