import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  transpilePackages: ["@cutpilot/core"],
  serverExternalPackages: ["@resvg/resvg-js", "@anthropic-ai/sdk"],
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  devIndicators: false,
};

export default config;
