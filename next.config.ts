import type { NextConfig } from "next";

// spawn reads the child crew's templates and screen_batch reads the idea-screen rules at runtime,
// so they ship with the /mcp function.
const config: NextConfig = {
  outputFileTracingIncludes: { "/mcp": ["./templates/child/**/*", "./rules/idea-screen.md"] },
};

export default config;
