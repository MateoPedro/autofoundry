import { appContext } from "@/lib/server/context";
import { serveSample } from "@/lib/server/samples";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ lead: string }> }) {
  return serveSample(appContext().db, (await params).lead);
}
