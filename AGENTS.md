# CLI agent guide

This repository is the public `@preprocess/cli` package. Read the CLI and
authoring specifications in `preprocess/platform` before changing behavior.

- Preserve non-interactive operation, stable exit codes, versioned machine
  output, and predictable diagnostic paths.
- Do not couple the CLI to private platform source or frontend implementation.
- Keep authentication and remote mutations explicit and safe for coding agents.
- Introduce commands from executable contracts, including failure cases.
- Run `pnpm check`, `pnpm test`, and `pnpm build` before handoff.

