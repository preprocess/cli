# `@preprocess/cli`

Process authoring and authenticated hosted-operation CLI and MCP server.

Install the public v1 release with:

```sh
npm install --global @preprocess/cli@^1.0.0
preprocess doctor --format json
```

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

All operations are flag-driven. Local commands stay credential-free and `run`
continues to default to `local`.

## Authentication and hosted operations

```sh
preprocess auth login
preprocess auth whoami --format json
preprocess auth logout

preprocess publish --root ./fabrication-orders \
  --process-id proc_01k5j9pdq7gh2mnb4cvxyz8t3e --version 1.2.3
preprocess run --environment development \
  --process-id proc_01k5j9pdq7gh2mnb4cvxyz8t3e \
  --process-version-id procv_01k5j9pdq7gh2mnb4cvxyz8t3e
preprocess runs list --environment development \
  --case-id case_01k5j9m2n8ef9tqr3vwxyz4a7b --revision 1
preprocess runs inspect --environment development \
  --case-id case_01k5j9m2n8ef9tqr3vwxyz4a7b --revision 1 \
  --execution-id execution-1
preprocess runs logs --environment development \
  --case-id case_01k5j9m2n8ef9tqr3vwxyz4a7b --revision 1 \
  --execution-id execution-1

preprocess promote --environment production \
  --process-id proc_01k5j9pdq7gh2mnb4cvxyz8t3e \
  --process-version-id procv_01k5j9pdq7gh2mnb4cvxyz8t3e
preprocess rollback --environment production \
  --process-id proc_01k5j9pdq7gh2mnb4cvxyz8t3e
```

Login uses an OAuth device-code flow. Authentication is stored in the macOS
keychain when available; the fallback file is restricted to mode `0600` inside
a mode-`0700` directory. Access tokens, refresh tokens, device codes, session
cookies, and CSRF tokens are never returned in CLI output. Expiring access
tokens refresh automatically.

`PREPROCESS_API_KEY` may provide bearer authentication for machine-safe
publication, hosted test runs, and authorized execution reads. It cannot drive
promotion or rollback. Those commands require the user session established by
device login and return an HTTPS authorization URL without mutating traffic when
the session or additional authority is missing.

Every hosted command requires `--environment development` or
`--environment production`; there is no hosted `local` or `preview`
environment. Publication uploads the exact canonical compiler bytes under a
content-derived idempotency key. It does not promote, bind credentials, or
widen capabilities.

For non-production development and deterministic fake servers,
`PREPROCESS_API_URL` and `PREPROCESS_AUTH_URL` select the two service origins.
Non-loopback origins must use HTTPS.

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

Local tools call the same CLI contract paths. `package_publish` requires
`processId` and `version`, compiles the exact package, and calls the same
idempotent publication boundary as the CLI. Execution artifact/log tools read
only bounded canonical local run artifacts.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

## Releases

Version tags matching `v<package version>` publish one exact, verified tarball
to npmjs through trusted publishing. The release job installs the frozen
dependency graph, checks and tests the CLI, inspects the package inventory,
installs the tarball in an isolated clean room, runs the real `preprocess`
binary with the public v1 authoring packages, and retains release evidence with
the source commit, package digest, npm integrity and shasum, file inventory,
dependency set, registry identity, toolchain versions, and verification
commands. No npm token is stored. The package remains `UNLICENSED`.
