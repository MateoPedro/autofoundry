import { monidClient } from "./monid-client";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function main() {
  const [command = "check", ...args] = process.argv.slice(2);
  const allowed: Record<string, string[]> = { check: [], mcp: ["--tool"], discover: ["--query"], inspect: ["--provider", "--endpoint"], "search-posts": ["--query"], result: ["--run"] };
  if (command === "--help") { console.log("pnpm monid check | mcp [--tool name] | discover --query text | inspect --provider slug --endpoint /path | search-posts --query text (one read, <=250 micro-USD) | result --run ID"); return; }
  if (!(command in allowed) || args.length % 2 || args.some((a, i) => i % 2 === 0 && !allowed[command].includes(a))) throw new Error("Unknown Monid command. Run pnpm monid --help.");
  const flags = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[2 * i], args[2 * i + 1]]));
  const client = monidClient();
  if (command === "search-posts" || command === "result") {
    const result = command === "search-posts" ? await client.searchPosts(flags["--query"] || "") : await client.getRun(flags["--run"] || "");
    if (typeof result.runId !== "string" || !/^[a-z0-9_-]{16,80}$/i.test(result.runId)) throw new Error("Monid returned no usable run ID. Inspect run history before retrying paid execution.");
    const directory = resolve("var/scout/monid");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, `${result.runId}.json`);
    await writeFile(path, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ run_id: result.runId, status: result.status, provider_http_status: result.providerResponse?.httpStatus,
      billing: result.billing, artifact: path }));
    if (result.status === "COMPLETED" && !(result.providerResponse?.httpStatus >= 200 && result.providerResponse?.httpStatus < 300)) process.exitCode = 1;
    if (["FAILED", "BLOCKED", "TIMED_OUT", "STOPPED"].includes(result.status)) process.exitCode = 1;
    return;
  }
  if (command === "mcp") {
    const tools = await client.mcpTools();
    console.log(JSON.stringify(flags["--tool"] ? tools.filter((t: { name: string }) => t.name === flags["--tool"]) : tools.map((t: { name: string; annotations?: { readOnlyHint?: boolean } }) => ({ name: t.name, read_only: t.annotations?.readOnlyHint })), null, 2));
    return;
  }
  if (command === "inspect") { console.log(JSON.stringify(await client.inspect(flags["--provider"] || "", flags["--endpoint"] || ""), null, 2)); return; }
  const result = await client.discover(command === "check" ? "twitter keyword search public business posts" : flags["--query"] || "");
  if (command === "check") console.log("Monid API connected. Free catalog discovery succeeded; no provider endpoint was executed.");
  else console.log(JSON.stringify(result, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Monid connection failed."); process.exitCode = 1; });
