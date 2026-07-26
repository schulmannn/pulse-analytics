# AGENTS

Project-specific guidance for AI coding agents.

The Astryx pilot is over — the app is back on ONE design system: its own components plus
Radix/shadcn primitives (`src/components/ui/*`) over the tokens in
[`DESIGN_TOKENS.md`](DESIGN_TOKENS.md). Do not add `@astryxdesign/*` packages or an `astryx` CLI
step back into this frontend; reach for the shared primitives (`Button`, `Badge`, `SegmentedControl`,
`DropdownMenu`, `PillSelect`, …) and token-backed Tailwind utilities instead.

Repo-wide rules live in [`../CLAUDE.md`](../CLAUDE.md).
