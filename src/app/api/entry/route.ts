import { entryResponse } from "@/lib/server/gate";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return entryResponse(request, process.env);
}
