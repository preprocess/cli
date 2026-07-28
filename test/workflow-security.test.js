import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/publish.yml", import.meta.url),
  "utf8",
);

test("the publish workflow is tag-only, least-privilege, and immutable", () => {
  assert.match(workflow, /tags:\s*\n\s+- "v\*\.\*\.\*"/);
  assert.doesNotMatch(
    workflow,
    /pull_request_target|workflow_run|self-hosted/,
  );
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /id-token: write/);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./);

  const actions = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map(
    (match) => match[1],
  );
  assert.ok(actions.length > 0);
  for (const action of actions) assert.match(action, /^[^@]+@[a-f0-9]{40}$/);

  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /npm@11\.18\.0/);
  assert.match(
    workflow,
    /npm publish "\$RELEASE_TARBALL" --access public --provenance/,
  );
});
