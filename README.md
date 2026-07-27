# `@preprocess/cli`

Credential-free, noninteractive Process authoring CLI and MCP server.

The local commands are a frontend to the versioned `@preprocess/project`,
`@preprocess/compiler`, and `@preprocess/harness` contracts. They do not import
private platform source or reproduce compiler/harness behavior. Those packages
must be supplied by the authoring distribution; a missing package is a local
environment failure (exit 2), while an incompatible contract uses exit 5.

## Local loop

```sh
preprocess init --root ./fabrication-orders \
  --project-key fabrication-orders --name "Fabrication orders"
preprocess doctor --format json
preprocess discover --root ./fabrication-orders --format json
preprocess check --root ./fabrication-orders --format json
preprocess test --root ./fabrication-orders --fixture fixtures/basic.json \
  --run-id fixture-basic --format json
preprocess eval --root ./fabrication-orders --fixture fixtures/basic.json
preprocess replay --root ./fabrication-orders --recording recordings/case.json
preprocess run --root ./fabrication-orders --environment local
preprocess inspect --root ./fabrication-orders
preprocess diff --left ./v1 --right ./v2
preprocess scaffold view --root ./fabrication-orders
```

All operations are flag-driven and noninteractive. Hosted environments,
authentication, publication, promotion, and rollback are deliberately outside
this package tranche. `run` accepts only `--environment local`.

`--format pretty`, `json`, and `jsonl` keep result data on stdout. Diagnostics
and progress are reserved for stderr. Exit codes are stable:

| Code | Meaning                                           |
| ---- | ------------------------------------------------- |
| 0    | success                                           |
| 1    | Process validation, harness, or assertion failure |
| 2    | usage or local environment failure                |
| 3    | authentication/authorization failure              |
| 4    | remote service failure                            |
| 5    | incompatible CLI/SDK/platform contract            |

Each check/test/eval/replay/local run writes mode-`0600` canonical artifacts to
`.preprocess/runs/<runId>/bundle.json` and `manifest.json`. Explicit run IDs are
bounded and cannot contain path separators. Fixture and recording input is
bounded and structurally rejected when it contains credential-bearing fields.

## MCP

`preprocess mcp` is a newline-delimited JSON-RPC transport over stdin/stdout. It
exposes:

- `project_discover`, `project_check`, `tests_run`, `replay_run`
- `versions_diff`, `schema_inspect`, `capabilities_inspect`, `package_build`
- `package_publish`, `execution_logs_query`, `execution_artifact_read`

Local tools call the same CLI contract paths. `package_publish` returns an
explicit PRE-67 hosted-boundary response; it never performs a hidden mutation.
Execution artifact/log tools read only bounded canonical local run artifacts.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```
