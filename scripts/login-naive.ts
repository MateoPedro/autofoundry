import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

type Profile = { api_key?: string; base_url?: string; org_id?: string };
type LoginConfig = { default_profile?: string; profiles?: Record<string, Profile> };

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Run pnpm naive:login in your local terminal. Enter your Naïve email and password when prompted; the password is hidden and never passed in command arguments. The resulting account session is saved as the official CLI's autofoundry profile.");
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Run pnpm naive:login yourself in an interactive local terminal. Do not send credentials through chat or command arguments.");
    process.exitCode = 1;
    return;
  }

  let hidden = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!hidden) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const prompt = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  prompt.on("SIGINT", () => process.exit(130));
  const baseUrl = "https://api.vetta.sh";
  const { createClient, ApiError } = await import("@usenaive-sdk/managed-agents");
  const makeClient = (apiKey: string) => createClient({
    baseUrl,
    apiKey,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }),
  });
  let password = "";

  try {
    console.log("Sign in to Naïve for the shared AutoFoundry company. No resources or paid work will be started.");
    const email = (await prompt.question("Email: ")).trim();
    process.stdout.write("Password (hidden): ");
    hidden = true;
    try {
      password = await prompt.question("");
    } finally {
      hidden = false;
      process.stdout.write("\n");
    }
    if (!email || !password) throw new Error("Email and password are required.");

    const auth = makeClient("");
    let session = await auth.auth.session({ email, password });
    const matches = session.organizations.filter((org) => org.name.replace(/[\s_-]/g, "").toLowerCase() === "autofoundry");
    let selected = matches.length === 1 ? matches[0] : undefined;
    if (!selected) {
      if (!session.organizations.length) throw new Error("This account has no available companies.");
      session.organizations.forEach((org, index) => console.log(`${index + 1}. ${org.name}`));
      const choice = (await prompt.question("Select the shared AutoFoundry company by number: ")).trim();
      if (!/^[1-9]\d*$/.test(choice)) throw new Error("A company number is required.");
      selected = session.organizations[Number(choice) - 1];
      if (!selected) throw new Error("The selected company is unavailable.");
    }
    if (session.organization_id !== selected.id) {
      session = await auth.auth.session({ email, password, organization_id: selected.id });
    }
    password = "";
    const identity = await makeClient(session.token).auth.me();
    if (identity.organization?.id !== selected.id) throw new Error("The session is not scoped to the selected company.");

    const path = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "vetta", "config.json");
    let previous: LoginConfig = {};
    try {
      previous = JSON.parse(await readFile(path, "utf8")) as LoginConfig;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw new Error("Existing CLI configuration could not be read; it was not replaced.");
      }
    }
    const config: LoginConfig = {
      ...previous,
      default_profile: "autofoundry",
      profiles: { ...previous.profiles, autofoundry: { base_url: baseUrl, api_key: session.token, org_id: selected.id } },
    };
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
      await chmod(path, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
    console.log(`Signed in to ${identity.organization.name} (${identity.organization.id}). Role: ${selected.role}.`);
    console.log(`Default CLI profile: autofoundry. Session expires: ${session.expires_at}.`);
    console.log("Run pnpm naive:check to verify the connection. Setup stops there; Scout has not been started.");
  } catch (error) {
    console.error(error instanceof ApiError ? `Naïve sign-in failed (HTTP ${error.status}). Check your account credentials and company access.` : "Naïve sign-in could not complete. Check the selected company, account credentials, network connection, and local configuration access.");
    process.exitCode = 1;
  } finally {
    password = "";
    prompt.close();
    output.end();
    process.stdin.pause();
    process.stdin.unref();
  }
}

main().catch(() => {
  console.error("Unable to start local Naïve sign-in. Verify the installed dependencies and retry.");
  process.exitCode = 1;
});
