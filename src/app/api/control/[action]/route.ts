import { appContext } from "@/lib/server/context";
import { controlResponse } from "@/lib/server/foundry/control";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  return controlResponse(request, (await params).action, appContext(), process.env);
}
