# Local Naïve setup

This is the environment-verification step of [Felix's build plan](AUTO_FOUNDRY_BUILD.md). Use the shared AutoFoundry company that holds the hackathon credits.

Felix owns the foundry app, database, and MCP tools. This checkout's immediate work is local tooling/authentication, then Scout. Scout needs Felix's deployed MCP URL, the supported tool names/input schemas for saving leads/clusters, and the documented connection-auth setup before its end-to-end run.

The project pins `@usenaive-sdk/managed-agents` 0.12.3 and `@usenaive-sdk/cli` 1.0.3. Install Node.js 24 and run `pnpm install` first.

## Connect

The SDK needs a programmatic credential. The official CLI supports both a project API key and an email/password account login; browser sign-in is not offered by the installed CLI. Being signed in to the website does not automatically authenticate a local SDK process.

For account email/password sign-in, run this yourself in an interactive local terminal:

```sh
pnpm naive:login
pnpm naive:check
```

The sign-in helper uses the official SDK's account-session endpoint at `https://api.vetta.sh`. It hides password input and disables prompt history, selects the AutoFoundry company (or asks you to choose), verifies the organization, and saves the session in the official CLI's local `autofoundry` profile with owner-only file permissions. Passwords are not saved or passed as command arguments. Other profiles are retained; `autofoundry` becomes the CLI's default profile, including outside this checkout. This is local sign-in, not a browser OAuth flow; accounts that cannot authenticate with a password will need another supported credential route.

For account sign-in, leave `NAIVE_API_KEY` empty in `.env.local` and leave `NAIVE_API_KEY`, `VETTA_API_KEY`, and `VETTA_PROFILE` unset in your shell. Those environment overrides take priority over the saved default login. The helper prints the selected company ID, role, and session expiration so you can confirm the account. Run `pnpm naive:login` again if the session expires or the check reports HTTP 401.

A project API key is the straightforward option for the shared application. Create it in the credited AutoFoundry company and save it locally:

```dotenv
# .env.local — ignored by Git
NAIVE_API_KEY=
NAIVE_API_BASE_URL=https://api.vetta.sh
```

Fill the empty key field in your editor. Keep the value out of chat, screenshots, command arguments, and Git.

If you already signed in with the official CLI, `pnpm naive:check` can use its saved profile instead. It follows `VETTA_PROFILE` or the CLI's default profile. That saved credential may be an API key or an account-session token. Each developer signs in locally; credentials are not shared through the repository.

```sh
pnpm naive:check
```

The check prints only the selected organization, live/test mode, read access to agents/apps, and—when the credential grants `billing:read`—credit balance and plan status. A key without billing permission can still connect successfully; the check explicitly reports that billing was not verified. It does not print keys, credential prefixes, email addresses, or raw provider errors. It performs no provisioning, inference, purchases, or outgoing messages.

Confirm the organization is the shared AutoFoundry company. The hackathon screenshot showed $250 credited and Pro covered through November 30; use the actual check result for current account status.

## Continue Felix's verification phase

After authentication is verified, check the required data/social tools, managed browser, identity/domain setup, Platform MCP, and hello-world app using the build plan. Keep a separate record of what was actually tested; successful account checks alone do not establish that these capabilities are enabled.

Native CLI commands are available through the pinned project tool:

```sh
pnpm naive whoami
pnpm naive credits show
pnpm naive plan show
pnpm naive models list
```

Those commands use the CLI's standard output; `whoami` includes account identity and a credential prefix. Prefer `pnpm naive:check` for a limited, shareable connection summary.

Sources: [Naïve quickstart](https://usenaive.ai/docs/quickstart), [SDK documentation](https://usenaive.ai/docs/sdk/typescript). CLI profile handling and login options were verified against the pinned package's help and implementation.
