import type { NextConfig } from "next";

// spawn reads the child crew's templates at runtime, so they ship with the /mcp function.
const config: NextConfig = {
  outputFileTracingIncludes: { "/mcp": ["./templates/child/**/*"] },
};

export default config;
