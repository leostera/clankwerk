import { DurableObject } from "cloudflare:workers"
import { getAgentByName } from "agents"
import {
  WorkflowScheduler,
  durableObjectRunStore,
  invokeRecordedAgent,
  type RunRecord,
} from "@leostera/clankwerk/runtime"
import { Researcher } from "../agents/researcher.ts"
import hello from "../workflows/hello.ts"
import { projectRun } from "./index.ts"
import { createApp } from "./api.ts"

export { Researcher }

type Env = Omit<Cloudflare.Env, "RESEARCHER"> & { RESEARCHER: DurableObjectNamespace<Researcher> }

/** Only Cloudflare binding and project-specific agent registry remain in the instance Worker. */
export class WorkflowRun extends DurableObject<Env> {
  private scheduler() {
    const store = durableObjectRunStore(this.ctx.storage)
    const project = (run: RunRecord) => projectRun(this.env.INDEX, run)
    return new WorkflowScheduler({
      id: this.ctx.id.toString(),
      workflows: { [hello.id]: hello },
      store,
      project,
      context: (run, step) => ({
        callAgent: (agentId, instanceName, request) =>
          invokeRecordedAgent({
            store,
            runId: run.id,
            stepId: step.id,
            leaseToken: step.leaseToken!,
            agentId,
            instanceName,
            request,
            project,
            authorize: (id, name, source) => {
              if (id !== "researcher" || !name || name.length > 128)
                throw new Error("Unknown agent or invalid instance")
              const route = `/agents/researcher/${encodeURIComponent(name)}`
              const path = new URL(source.url).pathname
              if (path !== route && !path.startsWith(`${route}/`)) throw new Error("Agent request path mismatch")
            },
            fetchAgent: async (_, name, forwarded) =>
              (await getAgentByName(this.env.RESEARCHER, name)).fetch(forwarded),
          }),
      }),
    })
  }

  start(workflowId: string, input: unknown, trigger?: RunRecord["trigger"]): Promise<RunRecord> {
    return this.scheduler().start(workflowId, input, trigger)
  }

  status(): Promise<RunRecord | undefined> {
    return this.scheduler().status()
  }
  alarm(): Promise<void> {
    return this.scheduler().alarm()
  }
}

export default createApp("__ADMIN__", "__TRIGGER__", "__NAME__")
