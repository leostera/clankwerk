import { AgentTaskError } from "libclank/agent"
import { createTriggerApp } from "libclank/cloudflare"
import { Id, Task } from "libclank/core"
import { ClankerDashboard } from "libclank/ui"

const nodeId: ReturnType<typeof Id.node> = Id.node()
const taskFactory: typeof Task.fn = Task.fn
const taskError: typeof AgentTaskError = AgentTaskError
const triggerAppFactory: typeof createTriggerApp = createTriggerApp
const dashboard: typeof ClankerDashboard = ClankerDashboard

void [nodeId, taskFactory, taskError, triggerAppFactory, dashboard]
