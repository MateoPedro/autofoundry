import type { NextConfig } from "next";

const config: NextConfig = {
  // The Team page reads each agent's deployed config and prompt from agents/ at request time.
  outputFileTracingIncludes: { "/team": ["./agents/**/*"] },
};

export default config;
