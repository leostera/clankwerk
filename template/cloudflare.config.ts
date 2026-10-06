import { bindings, defineConfig, exports } from "cf/config"
import * as entrypoint from "./worker/main.ts" with { type: "cf-worker" }

export default defineConfig({
  worker: {
    name: "__NAME__",
    entrypoint,
    compatibilityDate: "2026-10-06",
    compatibilityFlags: ["nodejs_compat"],
    domains: ["__ADMIN__", "__TRIGGER__"],
    workersDev: false,
    previewUrls: false,
    observability: { enabled: true, traces: { enabled: true } },
    env: {
      AI: bindings.ai(),
      INDEX: bindings.d1({ name: "__NAME__-index" }),
      RESEARCHER: bindings.durableObject({ worker: "__NAME__", exportName: "Researcher" }),
      RUNS: bindings.durableObject({ worker: "__NAME__", exportName: "WorkflowRun" }),
    },
    exports: {
      Researcher: exports.durableObject({ storage: "sqlite" }),
      WorkflowRun: exports.durableObject({ storage: "sqlite" }),
    },
  },
})
