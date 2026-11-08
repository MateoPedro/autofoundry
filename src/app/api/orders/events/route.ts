import { appContext } from "@/lib/server/context";
import { orderEventResponse } from "@/lib/server/foundry/payments";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return orderEventResponse(request, appContext(), process.env.VETTA_MCP_TOKEN);
}
