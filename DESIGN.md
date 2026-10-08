---
name: Clankwerk Operations
description: Read-only operational views for Clankwerk projects
colors:
  shell: "#fafbfc"
  canvas: "#ffffff"
  darkShell: "#19232e"
  darkCanvas: "#121a22"
  surface: "#ffffff"
  ink: "#18222d"
  muted: "#56616e"
  rule: "#e1e4e7"
  accent: "#b94f2e"
  focus: "#c7502b"
  success: "#176a42"
  danger: "#a03632"
typography:
  headline:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "27px"
    fontWeight: 690
    lineHeight: 1.2
    letterSpacing: "-0.035em"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "14px"
    fontWeight: 400
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "12px"
    fontWeight: 600
rounded:
  control: "5px"
  graphNode: "6px"
spacing:
  tight: "8px"
  regular: "16px"
  section: "48px"
components:
  search:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
  graph-node:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.graphNode}"
---

# Design System: Clankwerk Operations

## Overview

**Creative North Star: The Operations Map**

A neutral navigation rail orients operators; an open white canvas gives definitions, graphs, run tables, and event histories room to be read. It borrows the information density of familiar cloud dashboards, not their branding. Its accent marks active navigation and links into records, never synthetic activity.

## Principles

- Start with a real task: find an agent, inspect a workflow, follow a run, read its steps and events.
- The overview is an index of source definitions, protected entrypoints, and recent indexed runs, not a metrics wall. Search only loaded agents, workflows, triggers, and the latest 50 runs.
- A workflow graph shows manifest tasks and edges, with explicit caveats for missing connections and source-declared triggers. Do not draw fabricated trace spans.
- Show missing capability as missing capability, not zero usage. Agent-to-run links mean actual mediated calls; trigger history means accepted protected API starts. Neither direct agent sessions nor public webhook attempts are indexed. There is no OpenTelemetry trace view yet.
- A status color only describes a status returned by the API. Unknown statuses stay neutral.

## Color and type

In light mode use a white canvas, #fafbfc rail and hairline #e1e4e7 rules instead of cards. In dark mode use #121a22 canvas and #19232e rail with #35414d dividers. #b94f2e in light mode and #eca283 in dark mode carry interaction; semantic green and red indicate completed and failed states. Text uses a system sans. Monospace is reserved for run IDs and structured output, not headings. Time and counts use tabular numerals. Maintain readable contrast for body and muted text.

## Layout and interaction

Desktop has a 226px rail that collapses to 68px with accessible icon links; its state persists per browser. The cog turns slowly except under reduced motion. A keyboard-accessible quick search sits below project identity (⌘K); the overview reuses its results rather than duplicating the field. Agents, workflows and triggers expand to real source-defined items; Settings sits below a divider and the quiet icon-only collapse control (⌘B) is pinned last. Below 740px, all top-level navigation and Settings remain visible regardless of desktop collapse preference; sub-items remain reachable from their index pages. Overview entities form three columns on wide screens, two on medium, one on phones. Tables retain their columns inside a horizontal scrolling region. Workflow graphs scroll independently when wide. Run steps and recorded events sit beside one another on desktop and stack on narrow screens.

Use native links for navigation, a working GET quick search that navigates to scoped overview results, and native labeled radio buttons for Light/Dark/Auto in Settings. The optional Codex connection section uses the same settings-section rhythm and explicit connected/disconnected states; it appears only for instances declaring the connector. After connection, a native select offers only live catalog models for the project default; declared agent pages offer a per-agent override or inherit that default. Saved choices are shown honestly when no longer available, and a catalog entry never implies a successful inference turn. The preference is browser-local and Auto follows OS changes. Native browser refresh is sufficient; only failed requests have a retry control. Focus rings are visible. Row links, loading skeletons, errors, and empty states use the same quiet vocabulary throughout. Motion only confirms state; it never stages page arrival.

## Do / don't

- **Do** distinguish source definitions, indexed history, and events from agent executions and trace spans.
- **Do** link workflows to runs, runs to recorded agent calls and accepted-start provenance, agent details to mediated calls, and triggers to their accepted-start histories.
- **Do** label sampled counts (the latest 50 runs across this project).
- **Don't** claim Access or trigger requests are covered by the run audit log.
- **Don't** add utility bars, false breadcrumbs, empty dashboard tiles, placeholder sparklines, or redundant refresh buttons.
