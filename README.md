# `@preprocess/cli`

Public command-line interface for authoring, testing, inspecting, and publishing
Preprocess Processes.

The CLI is designed for people and coding agents: non-interactive by default,
stable exit codes, versioned JSON output, and diagnostics written to predictable
paths.

## Development

```sh
corepack enable
pnpm install
pnpm check
pnpm test
pnpm build
```

Commands will be added from executable contracts maintained in the private
`preprocess/platform` repository. The initial API client will remain a small,
hand-written fetch layer so CLI delivery is not coupled to API documentation
generation.

