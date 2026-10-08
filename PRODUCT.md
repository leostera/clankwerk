# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers and operators running their own Clankwerk agent/workflow project in their Cloudflare account. They need to find source definitions, understand workflow structure, and follow actual runs to their steps and recorded events.

## Product Purpose

A code-defined agent and durable workflow platform with a private operational dashboard: agents, workflows and their runs, trigger configuration and executions, and a timeline of recorded audit events. The first dashboard slice is read-only (confirmed by user).

## Positioning

One self-owned Cloudflare project. Think-backed agent definitions have many Durable Object instances; Clankwerk executes graph workflows using its own per-run coordinator Durable Objects, not Cloudflare Workflows.

## Operating Context

The dashboard is served on the Access-protected admin hostname. A separate public trigger hostname currently returns 404. The initial sample registers one agent, one workflow, and an Access-protected API entrypoint; D1 indexes run, mediated agent-call, accepted API-start, and audit facts. Operators use this UI to inspect actual project state, not to change it in the first slice.

## Capabilities and Constraints

Read-only overview and scoped search of loaded agents, workflows, protected entrypoints, and latest 50 indexed runs; source-manifest workflow graph, run steps/events, actual workflow-mediated agent calls, and accepted API-start history. The sidebar may collapse on desktop. Settings stores Light/Dark/Auto appearance in the current browser and shows read-only project details. An instance may opt into the Codex connection card and model selection: Settings chooses a default from the connected account's live catalog and declared agent pages offer per-agent overrides. Saves validate against the server-side catalog and never expose credentials; ordinary scaffold projects do not expose the connector or selectors. Only existing data may be shown as facts. Direct agent sessions, unmediated calls, rejected trigger requests, public webhook execution, and OpenTelemetry spans are not indexed; show honest limits. Access must protect the dashboard's assets and API on the admin hostname. The UI must remain useful with zero runs or audit events.

## Brand Commitments

The user named Cloudflare's dashboard (`dash.cloudflare.dev`, as supplied) as a design inspiration for this agentic workflow platform. Use its operator-focused navigation and information density as inspiration, not Cloudflare branding or a pixel copy.

## Evidence on Hand

`packages/clankwerk/template/worker/main.ts`, `packages/clankwerk/template/worker/index.ts`, `examples/clankwerk-live/`, and `docs/rfds/RFD0002-clankwerk-cloudflare-native.md` show currently available data and boundaries. The API entrypoint records accepted starts and mediated agent calls; no public trigger delivery or complete agent-instance index exists.

## Product Principles

- Distinguish source definitions, agent instances, and executions.
- Surface failures and state truth without invented metrics.
- Make the path from a workflow graph to a run and its step/event history easy to follow.
- Treat missing/unsupported data as a product state, not as an empty success.
