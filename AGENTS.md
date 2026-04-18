# Agent Guide

> Read `.ai/` files for detailed context.

**Project**: OpenCode plugin for the Google (custom) provider with Antigravity and Gemini CLI auth
**Stack**: TypeScript, Bun, @opencode-ai/plugin SDK
**Platform**: Linux, macOS, Windows

## Commands

```bash
bun run build       # bundle + emit declarations
bun run typecheck   # tsc --noEmit
bun run test        # bun test
bun run lint        # oxlint + oxfmt --check
bun run lint:fix    # auto-fix lint + format
bun run format      # oxfmt --write
```

## Context Files

- Rules: `.ai/RULES.md`
- Architecture: `.ai/ARCHITECTURE.md`

## Critical Rules

1. No decorative comments, section dividers, or ASCII art
2. Comments only when the why is non-obvious
3. No AI patterns in code, comments, commits, or PR descriptions — match the repo's existing commit style
4. All code and comments in English
5. Run `bun run typecheck && bun run build && bun run lint` before completing any task
6. Keep auth, model visibility, and request routing aligned with Google (custom), Antigravity, and Gemini CLI Cloud Code flows
7. Logging goes through `src/logger.ts`, never raw console.log
8. Empty catch blocks are only acceptable when failure is explicitly expected and harmless
