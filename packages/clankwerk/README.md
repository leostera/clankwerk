# Clankwerk

Cloudflare-native, source-defined workflows and agents. A project declares triggers and task graphs; the shared runtime handles durable execution, deduplication, event correlation, retries and audit lineage in the project's existing Worker. No deployable Worker is needed per workflow.

```ts
import { Clankwerk, Id, Task, Triggers } from "@leostera/clankwerk"
import { Effect } from "effect"

const trigger = Triggers.manual<string>({ id: Id.trigger("greet") })
const greet = Task.fn({ id: Id.node("greet"), run: (name: string) => Effect.succeed(`Hello, ${name}`) })
export default Clankwerk.defineWorkflow({ id: "greeting", graph: trigger.then(greet) })
```

- `@leostera/clankwerk/runtime`: `WorkflowScheduler`, `WorkflowQueue`, trigger dispatch, Cloudflare storage adapters and recorded agent calls.
- `@leostera/clankwerk/connectors/github-trigger`: signed, scoped GitHub webhook triggers (issues, PR heads, reviews and comments).
- `@leostera/clankwerk/connectors/github-connection`: encrypted GitHub OAuth custody, read-only Git, scoped draft publication and commit-specific review. Configure its repository, base and branch prefix in the trusted Worker; never bind the credential to a Coder container.
- `@leostera/clankwerk/connectors/coder-workspace`: credential-free, bounded Cloudflare Sandbox checkout and draft preparation. Host it in a separate container-enabled Worker only when the app needs a Linux workspace.
- Other Codex connector modules are available as individual subpath exports.

Use `clankwerk new <project> --domain <admin-hostname>` to scaffold an example with a declared manual trigger and thin Worker adapter. See the repository's `docs/github-workflows.md` for event workflow design and security/cutover requirements. Neither Clankwerk nor its connectors merge PRs automatically.
