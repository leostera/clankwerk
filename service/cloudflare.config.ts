import { bindings, defineConfig, exports } from "cf/config"
import * as entrypoint from "./src/worker.ts" with { type: "cf-worker" }

export default defineConfig({
  worker: {
    name: "clankwerk-connect",
    entrypoint,
    domains: ["clankwerk.leostera.dev"],
    compatibilityDate: "2026-10-06",
    compatibilityFlags: ["nodejs_compat"],
    workersDev: false,
    previewUrls: false,
    observability: { enabled: true, traces: { enabled: true } },
    env: {
      GITHUB_APP_ID: bindings.text("5213684"),
      GITHUB_CLIENT_ID: bindings.text("Iv23liqK5uKdioKAUNsp"),
      GITHUB_CLIENT_SECRET: bindings.secret(),
      GITHUB_WEBHOOK_SECRET: bindings.secret(),
      INSTANCE_REGISTRY: bindings.secret(),
      HANDOFF_ENCRYPTION_KEY: bindings.secret(),
      INSTALLATIONS: bindings.durableObject({ worker: "clankwerk-connect", exportName: "GitHubInstallation" }),
      OAUTH: bindings.durableObject({ worker: "clankwerk-connect", exportName: "GitHubOAuthSession" }),
    },
    exports: {
      GitHubInstallation: exports.durableObject({ storage: "sqlite" }),
      GitHubOAuthSession: exports.durableObject({ storage: "sqlite" }),
    },
  },
})
