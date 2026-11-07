import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ToolError, type Tool, type ToolContext, type ToolErrorCode } from "../foundry/tool";

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_VERSION = SUPPORTED_VERSIONS[0];

type JsonRpcId = string | number | null;
type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } };

const request = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export function isAuthorized(header: string | null, token: string | undefined): boolean {
  if (!token || !header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// The SDK is ESM-only, so its ApiError is recognised by shape rather than imported.
function isNaiveApiError(error: unknown): error is Error & { status: number; requestId: string } {
  return error instanceof Error && typeof (error as { requestId?: unknown }).requestId === "string" && typeof (error as { status?: unknown }).status === "number";
}

function inputSchema(tool: Tool) {
  const schema = z.toJSONSchema(tool.input) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

function toolResult(value: unknown, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

function toolFailure(code: ToolErrorCode, message: string) {
  return toolResult({ error: { code, message } }, true);
}

async function callTool(tools: Tool[], ctx: ToolContext, params: Record<string, unknown>) {
  const tool = tools.find((t) => t.name === params.name);
  if (!tool) return toolFailure("not_found", `no such tool: ${String(params.name)}`);
  const parsed = tool.input.safeParse(params.arguments ?? {});
  if (!parsed.success) return toolFailure("invalid", z.prettifyError(parsed.error));
  try {
    return toolResult(await tool.run(ctx, parsed.data));
  } catch (error) {
    if (error instanceof ToolError) return toolFailure(error.code, error.message);
    console.error(`foundry tool ${tool.name} failed`, error);
    if (isNaiveApiError(error)) return toolFailure("naive_error", `${error.message} (${error.requestId})`);
    return toolFailure("invalid", error instanceof Error ? error.message : String(error));
  }
}

export async function handleRpc(message: unknown, tools: Tool[], ctx: ToolContext): Promise<JsonRpcResponse | null> {
  const parsed = request.safeParse(message);
  if (!parsed.success) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  const { id, method, params = {} } = parsed.data;
  if (id === undefined) return null;

  const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const protocolVersion = typeof asked === "string" && SUPPORTED_VERSIONS.includes(asked) ? asked : DEFAULT_VERSION;
      return reply({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "foundry", version: "0.1.0" } });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t) })) });
    case "tools/call":
      return reply(await callTool(tools, ctx, params));
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}
