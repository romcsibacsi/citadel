# Attributions

This product ships with **zero third-party runtime dependencies** — at runtime it
uses only the Node.js standard library (`node:sqlite`, `node:http`, `node:crypto`,
`node:fs`, …). The credits below cover the Node.js runtime and the
build/development toolchain (the latter is not shipped to the runtime).

## Runtime

- **Node.js** — the JavaScript runtime and its built-in modules. MIT-licensed
  (© the Node.js contributors).

## Build / development toolchain (not part of the shipped runtime)

| Tool | Purpose | License |
|---|---|---|
| TypeScript | type-checking + `dist/` compilation | Apache-2.0 |
| esbuild | web SPA bundling | MIT |
| tsx | running TypeScript directly in tests/dev | MIT |
| Playwright | headless UI tests | Apache-2.0 |
| @types/node | Node type definitions | MIT |

No code, prompts, branding, or assets from any other product are included; the
orchestrator is an independent clean-room implementation. See `LICENSE` for the
terms governing this software itself.
