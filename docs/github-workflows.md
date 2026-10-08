# GitHub event workflows

Clankwerk owns authenticated event admission and durable execution. An instance supplies a GitHub webhook secret, repository scope, workflow tasks, agent bindings, and optional authorization policy. **No additional Worker is needed for each workflow.** Credential-bearing GitHub APIs run only in the trusted instance Worker; a Coder container sees a read-only Git gateway, never the OAuth token.

## Declare the source in `triggers/`

```ts
import { githubTriggers } from "@leostera/clankwerk/connectors/github-trigger"

export const github = (secret: string) =>
  githubTriggers({
    secret,
    repository: "leostera/r4",
    path: "/github/issues",
  })
```

Build this definition per request or per DO invocation with the current binding; don't capture a secret in a module-global variable. The connector verifies the raw GitHub HMAC _before_ decoding. `issue`, `pull`, `review`, `comment`, and `push` are actual `Triggers.webhook` graph nodes. Set `baseBranch: "main"` to scope `push` to base movement. All may share one URL. Their payloads are **untrusted data**, including author and review text. A signed delivery proves GitHub sent it, not that it is authorized to start Coder.

```ts
import { Clankwerk, Task, Workflow, Id } from "@leostera/clankwerk"
import { Effect } from "effect"
import type {
  GitHubIssueEvent,
  GitHubReviewEvent,
  GitHubCommentEvent,
} from "@leostera/clankwerk/connectors/github-trigger"
import { github } from "../triggers/github.ts"

type ContributionEvent = GitHubIssueEvent | GitHubReviewEvent | GitHubCommentEvent
export function defineGitHubWorkflows(secret: string) {
  const source = github(secret)
  const review = Clankwerk.defineWorkflow({
    id: "code-review",
    graph: source.pull.then(
      Task.fn({
        id: Id.node("read-exact-pr-head"),
        run: (event) => Effect.succeed({ number: event.number, commit: event.head }),
      }),
    ),
  })
  const contribution = Clankwerk.defineWorkflow({
    id: "contribute",
    graph: Workflow.oneOf<ContributionEvent>([source.issue, source.review, source.comment]).then(
      Task.fn({
        id: Id.node("validate-actionability"),
        run: (event: ContributionEvent) => Effect.succeed({ number: event.number }),
      }),
    ),
    // A single issue's feedback and coding turns never run against its workspace concurrently.
    partition: (_triggerId, value) => `leostera/r4:issue:${(value as ContributionEvent).number}`,
  })
  return [review, contribution]
}
```

The graph examples indicate the API shape, **not** a production-ready contribution workflow. Check eligible issue authors, command permissions, current PR head, review receipt ID and verdict, path limits, no-progress policy and actual Coder test output in source-defined tasks. Never treat a comment marker or agent output as authorization. Never auto-merge.

## Dispatch and storage

The trigger-host HTTP boundary calls `dispatchWebhook(request, [review, contribution], activate)`. `activate` routes each event to `event.partition` using a durable namespace in the **existing Worker**. A per-partition object composes `WorkflowQueue`, `durableObjectQueueStore`, `WorkflowScheduler` and `durableObjectRunStore(storage, "run:" + event.key)`. Its `alarm()` delegates to the queue. No instance-specific phase machine is needed.

Each event gets a deterministic, workflow-namespaced hash key. Re-delivery is deduplicated. Different PR commits produce distinct review runs. Contributions are serialized by issue. The queue holds up to 100 pending events and has a 1,000-round hard ceiling; workflow tasks must enforce earlier no-progress stops. A failed or incompatible round blocks the partition for inspection rather than starting another round. Query projections are not authoritative.

A manual/API source uses `Triggers.manual<Input>(...)` in `triggers/`, included in the workflow graph, and `dispatchManual` at the Access-protected HTTP boundary. Scheduled polling uses `Triggers.cron` and `dispatchCron(schedule, scheduledTime, workflows, activate)` from the platform `scheduled` handler. Replays in the same minute deduplicate; cron values are part of the workflow manifest. Never start a task directly while claiming it came from a trigger.

## Capabilities

- `GitHubConnection` stores encrypted user-to-server tokens, refreshes via a signed service binding and restricts all automated writes to its configured repository and branch prefix. Its `reviewSnapshot` is read-only (including fork PRs); `recordReview` posts a **COMMENTED**, exact-head review, pre-reserving a private nonce before the GitHub write. `trustedReview` verifies the returned review ID before revision. `ownedDraft(number, commit)` resolves an exact-head PR to an actual issue through its configured branch policy and a fresh GitHub issue read; PR body markers alone cannot authorize a revision.
- `CoderWorkspace` is a separate, credential-free container. Its trusted Git gateway allows `git-upload-pack`, not push. `prepareDraft` produces bounded text-only files and a digest; the GitHub connector publishes with expected base/head checks and never force-pushes.
- Tasks must provide stable idempotency keys for remote agent submissions and other external effects. The scheduler fences late step results and retries interrupted steps, but it cannot make a third-party API exactly-once by itself. GitHub publication and review helpers check remote state for retry recovery.

## Release and cutover

Package code and the scaffold template are tested together. Publish a new pinned package version before switching an instance to these exports; do not deploy against an adjacent checkout. Verify package contents contain no service secrets. Enabling GitHub `pull_request`, `pull_request_review`, `issue_comment`, and `push` webhook subscriptions, migrating existing issue-run history, and removing an instance's legacy coordinator are **instance cutover steps**, not package publication steps.
