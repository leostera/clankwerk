import { bindings, defineConfig, exports } from "cf/config"
import * as entrypoint from "./worker/main.ts" with { type: "cf-worker" }

export default defineConfig({
  worker: {
    name: "clankwerk-live",
    entrypoint,
    assets: { runWorkerFirst: true, notFoundHandling: "none", htmlHandling: "none" },
    compatibilityDate: "2026-10-06",
    compatibilityFlags: ["nodejs_compat"],
    domains: ["clankwerk.leostera.dev", "triggers.clankwerk.leostera.dev"],
    workersDev: false,
    previewUrls: false,
    observability: { enabled: true, traces: { enabled: true } },
    env: {
      AI: bindings.ai(),
      ASSETS: bindings.assets(),
      INDEX: bindings.d1({ name: "clankwerk-live-index" }),
      RESEARCHER: bindings.durableObject({ worker: "clankwerk-live", exportName: "Researcher" }),
      RUNS: bindings.durableObject({ worker: "clankwerk-live", exportName: "WorkflowRun" }),
    },
    exports: {
      Researcher: exports.durableObject({ storage: "sqlite" }),
      WorkflowRun: exports.durableObject({ storage: "sqlite" }),
    },
  },
})
