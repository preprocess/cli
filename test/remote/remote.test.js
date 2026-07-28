import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CLI_SCHEMA_VERSION,
  execute,
  serveMcp,
} from "../../dist/index.js";
import {
  FileCredentialStore,
} from "../../dist/auth/store.js";

const processId = "proc_01k5j9pdq7gh2mnb4cvxyz8t3e";
const processVersionId = "procv_01k5j9pdq7gh2mnb4cvxyz8t3e";
const previousVersionId = "procv_01k5j9pdq7gh2mnb4cvxyz8t3f";
const caseId = "case_01k5j9m2n8ef9tqr3vwxyz4a7b";
const workspaceId = "ws_01k5j9pdq7gh2mnb4cvxyz8t3e";
const digest = `sha256:${"a".repeat(64)}`;
const timestamp = "2026-07-28T12:00:00.000Z";

class MemoryCredentialStore {
  value = null;

  async load() {
    return this.value;
  }

  async save(value) {
    this.value = structuredClone(value);
  }

  async clear() {
    this.value = null;
  }
}

class ImmediateClock {
  value = Date.parse(timestamp);
  sleeps = [];

  now() {
    return this.value;
  }

  async sleep(milliseconds, signal) {
    if (signal?.aborted) {
      const error = new Error("Operation cancelled.");
      error.name = "AbortError";
      throw error;
    }
    this.sleeps.push(milliseconds);
    this.value += milliseconds;
  }
}

function io(root, env = {}) {
  const stdout = [];
  const stderr = [];
  return {
    value: {
      stdout: { write: (value) => stdout.push(String(value)) },
      stderr: { write: (value) => stderr.push(String(value)) },
      cwd: root,
      env,
      isTty: false,
    },
    stdout,
    stderr,
  };
}

function projectContracts(packageBytes = Buffer.from('{"package":"exact"}')) {
  const packageDigest = `sha256:${createHash("sha256")
    .update(packageBytes)
    .digest("hex")}`;
  return {
    versions: {
      project: "preprocess.project/v1",
      compiler: "0.1.0",
      harness: "0.1.0",
    },
    discoverProcessProject() {
      throw new Error("not used");
    },
    compileProcess(root) {
      return {
        ok: true,
        project: { root, projectKey: "fixture-process" },
        manifest: {
          projectKey: "fixture-process",
          capabilities: { outbound: [] },
          digests: { package: packageDigest },
        },
        package: {
          formatVersion: "preprocess.package/v1",
          contentDigest: digest,
          manifestDigest: digest,
        },
        packageBytes,
        diagnostics: { diagnostics: [], errorCount: 0 },
      };
    },
    async runHarness() {
      throw new Error("not used");
    },
  };
}

function processVersion(version = "1.2.3") {
  return {
    id: processVersionId,
    processId,
    version,
    contentDigest: digest,
    manifestDigest: digest,
    manifest: { projectKey: "fixture-process" },
    packageBytes: 19,
    manifestBytes: 20,
    source: { kind: "local", commitSha: null, dirty: false },
    sdkVersion: "1.0.0",
    compilerVersion: "0.1.0",
    formatVersion: "preprocess.package/v1",
    capabilities: { outbound: [] },
    testSummary: { passed: true, tests: 0, failures: [] },
    wfpScriptName: "process-version",
    state: "published",
    publishedAt: timestamp,
    createdAt: timestamp,
  };
}

function identity() {
  return {
    id: "execution-1",
    caseId,
    caseRevision: 1,
    generation: 1,
    caseSequence: 1,
    status: "completed",
    createdAt: timestamp,
    terminalAt: timestamp,
  };
}

function executionDetail() {
  return {
    identity: identity(),
    scope: {
      workspaceId,
      processId,
      processVersionId,
      caseStatus: "completed",
      throughSequence: 1,
    },
    supervisor: [],
    waits: [],
    agents: [],
    workItems: [],
    effects: [],
    interventions: [],
    schemas: [],
    workspace: [],
    memory: [],
    patches: [],
  };
}

function executionLogs() {
  return {
    taxonomyVersion: "1",
    executionId: "execution-1",
    caseId,
    revision: 1,
    classification: "standard",
    throughSequence: 1,
    data: [
      {
        schemaVersion: "1",
        sequence: 1,
        source: "case_runtime",
        eventType: "case.completed",
        sourceId: "execution-1",
        attempt: 0,
        correlationId: "correlation-1",
        status: "completed",
        classification: "standard",
        occurredAt: timestamp,
        terminalAt: timestamp,
        messageCode: "case.completed",
        messageTemplate: "Recorded canonical execution state.",
        redaction: { applied: false, fields: [] },
        evidence: [{ kind: "canonical_record", id: "execution-1" }],
      },
    ],
    nextCursor: null,
    hasMore: false,
  };
}

function activation() {
  return {
    processId,
    environment: "development",
    activeVersionId: processVersionId,
    previousVersionId,
    bindingDigest: digest,
    updatedAt: timestamp,
  };
}

async function withServer(handler, callback) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    });
    await handler(request, response, body, requests);
  });
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  assert.equal(typeof address, "object");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    return await callback({ url, requests });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    "preprocess-request-id": `req_${"1".repeat(26)}`,
    ...headers,
  });
  response.end(JSON.stringify(value));
}

test("device login polls safely, refreshes automatically, identifies, and logs out without token output", async () => {
  const store = new MemoryCredentialStore();
  const clock = new ImmediateClock();
  let tokenCalls = 0;
  await withServer(
    (request, response) => {
      if (request.url === "/oauth2/device_authorization") {
        return json(response, 200, {
          device_code: "device-code-not-for-output",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.preprocess.com/device",
          expires_in: 60,
          interval: 1,
        });
      }
      if (request.url === "/oauth2/token") {
        tokenCalls += 1;
        if (tokenCalls === 1)
          return json(response, 400, { error: "authorization_pending" });
        if (tokenCalls === 2)
          return json(response, 200, {
            access_token: "initial-access-token-secret",
            refresh_token: "refresh-token-secret",
            session_cookie: "session-cookie-secret",
            csrf_token: "csrf-token-secret",
            token_type: "Bearer",
            expires_in: 1,
          });
        return json(response, 200, {
          access_token: "refreshed-access-token-secret",
          refresh_token: "refresh-token-secret",
          session_cookie: "refreshed-session-secret",
          csrf_token: "refreshed-csrf-secret",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (request.url === "/v1/me") {
        assert.equal(
          request.headers.authorization,
          "Bearer refreshed-access-token-secret",
        );
        return json(response, 200, {
          principal: { kind: "user", id: "user_01HABC" },
          organization: { id: "org_01HABC" },
          workspace: { id: workspaceId },
          environment: "development",
          capabilities: ["process:publish"],
        });
      }
      return json(response, 404, {
        error: { code: "PP_NOT_FOUND", message: "no", status: 404 },
      });
    },
    async ({ url }) => {
      const root = mkdtempSync(join(tmpdir(), "preprocess-auth-"));
      try {
        const login = io(root);
        const loginResult = await execute(
          ["auth", "login"],
          login.value,
          undefined,
          {
            apiBaseUrl: url,
            authBaseUrl: url,
            credentialStore: store,
            clock,
          },
        );
        assert.equal(loginResult.exitCode, 0);
        const allOutput = `${login.stdout.join("")}${login.stderr.join("")}`;
        assert.match(allOutput, /ABCD-EFGH/);
        assert.doesNotMatch(allOutput, /access-token|refresh-token|session-cookie|device-code/);
        assert.equal(store.value.accessToken, "initial-access-token-secret");

        clock.value += 60_000;
        const me = io(root);
        const meResult = await execute(
          ["auth", "whoami"],
          me.value,
          undefined,
          {
            apiBaseUrl: url,
            authBaseUrl: url,
            credentialStore: store,
            clock,
          },
        );
        assert.equal(meResult.exitCode, 0);
        assert.equal(JSON.parse(me.stdout.join("")).schemaVersion, CLI_SCHEMA_VERSION);
        assert.equal(store.value.accessToken, "refreshed-access-token-secret");
        assert.doesNotMatch(me.stdout.join(""), /refreshed-access-token/);

        const logout = io(root);
        assert.equal(
          (
            await execute(
              ["auth", "logout"],
              logout.value,
              undefined,
              { credentialStore: store, clock },
            )
          ).exitCode,
          0,
        );
        assert.equal(store.value, null);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

test("fallback credential storage is mode-restricted and rejects permissive files", async () => {
  const root = mkdtempSync(join(tmpdir(), "preprocess-auth-file-"));
  const path = join(root, "nested", "session.json");
  try {
    const store = new FileCredentialStore(path);
    await store.save({
      schemaVersion: "preprocess.auth/v1",
      accessToken: "access-token-secret",
      refreshToken: "refresh-token-secret",
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).accessToken, "access-token-secret");
    assert.equal((await store.load()).refreshToken, "refresh-token-secret");
    chmodSync(path, 0o644);
    await assert.rejects(
      () => store.load(),
      /permissions are not restricted/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("device authorization expiry is deterministic and discloses no device token", async () => {
  const store = new MemoryCredentialStore();
  const clock = new ImmediateClock();
  await withServer(
    (request, response) => {
      if (request.url === "/oauth2/device_authorization")
        return json(response, 200, {
          device_code: "expiring-device-code-secret",
          user_code: "EXPI-REDS",
          verification_uri: "https://auth.preprocess.com/device",
          expires_in: 2,
          interval: 1,
        });
      return json(response, 400, { error: "authorization_pending" });
    },
    async ({ url }) => {
      const root = mkdtempSync(join(tmpdir(), "preprocess-auth-expiry-"));
      try {
        const streams = io(root);
        const result = await execute(
          ["auth", "login"],
          streams.value,
          undefined,
          {
            authBaseUrl: url,
            credentialStore: store,
            clock,
          },
        );
        assert.equal(result.exitCode, 3);
        assert.equal(store.value, null);
        assert.doesNotMatch(
          `${streams.stdout.join("")}${streams.stderr.join("")}`,
          /expiring-device-code-secret/,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

test("publish sends the exact compiler bytes with a stable idempotency key and cannot promote", async () => {
  const store = new MemoryCredentialStore();
  store.value = {
    schemaVersion: "preprocess.auth/v1",
    accessToken: "publisher-access-token",
    expiresAt: Date.now() + 3_600_000,
  };
  const bytes = Buffer.from('{"package":"exact"}');
  let firstKey;
  await withServer(
    (_request, response, body, requests) => {
      const parsed = JSON.parse(body);
      assert.equal(
        Buffer.from(parsed.packageBase64, "base64").toString(),
        bytes.toString(),
      );
      assert.deepEqual(parsed.manifest.capabilities, { outbound: [] });
      assert.equal(requests.at(-1).url, `/v1/processes/${processId}/versions`);
      firstKey ??= requests.at(-1).headers["idempotency-key"];
      assert.equal(requests.at(-1).headers["idempotency-key"], firstKey);
      assert.equal(requests.at(-1).headers.authorization, "Bearer publisher-access-token");
      return json(response, 201, processVersion(), {
        "idempotent-replay": requests.length > 1 ? "true" : "false",
      });
    },
    async ({ url, requests }) => {
      const root = mkdtempSync(join(tmpdir(), "preprocess-publish-"));
      try {
        for (let index = 0; index < 2; index += 1) {
          const streams = io(root);
          const result = await execute(
            [
              "publish",
              "--process-id",
              processId,
              "--version",
              "1.2.3",
            ],
            streams.value,
            projectContracts(bytes),
            { apiBaseUrl: url, credentialStore: store },
          );
          assert.equal(result.exitCode, 0);
        }
        assert.equal(requests.length, 2);
        assert.ok(requests.every((item) => !item.url.includes("promotion")));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

test("MCP package_publish uses the same authenticated immutable publication boundary", async () => {
  await withServer(
    (request, response) => {
      assert.equal(request.headers.authorization, "Bearer mcp-publisher-token");
      return json(response, 201, processVersion("2.0.0"));
    },
    async ({ url, requests }) => {
      const root = mkdtempSync(join(tmpdir(), "preprocess-mcp-publish-"));
      try {
        async function* input() {
          yield `${JSON.stringify({
            id: 1,
            method: "tools/call",
            params: {
              name: "package_publish",
              arguments: { root, processId, version: "2.0.0" },
            },
          })}\n`;
        }
        const streams = io(root, {
          PREPROCESS_API_KEY: "mcp-publisher-token",
          PREPROCESS_API_URL: url,
        });
        await serveMcp(
          { ...streams.value, stdin: input() },
          projectContracts(),
        );
        const response = JSON.parse(streams.stdout.join(""));
        assert.equal(response.result.ok, true);
        assert.equal(response.result.value.processVersion.version, "2.0.0");
        assert.equal(requests.length, 1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

test("hosted run and execution commands require environment and preserve scoped request identity", async () => {
  const store = new MemoryCredentialStore();
  store.value = {
    schemaVersion: "preprocess.auth/v1",
    accessToken: "hosted-run-access-token",
    expiresAt: Date.now() + 3_600_000,
  };
  await withServer(
    (request, response) => {
      assert.equal(request.headers["preprocess-environment"], "development");
      if (request.url === "/v1/test-runs")
        return json(response, 201, {
          id: "run-1",
          processId,
          processVersionId,
          environment: "development",
          status: "queued",
          createdAt: timestamp,
        });
      if (request.url.startsWith("/v1/executions?"))
        return json(response, 200, {
          data: [{ identity: identity() }],
          nextCursor: null,
          hasMore: false,
        });
      if (request.url.startsWith("/v1/executions/execution-1/logs?"))
        return json(response, 200, executionLogs());
      if (request.url.startsWith("/v1/executions/execution-1?"))
        return json(response, 200, executionDetail());
      throw new Error(`unexpected ${request.url}`);
    },
    async ({ url }) => {
      const root = mkdtempSync(join(tmpdir(), "preprocess-hosted-"));
      try {
        const missing = io(root);
        assert.equal(
          (
            await execute(
              ["runs", "list", "--case-id", caseId, "--revision", "1"],
              missing.value,
              undefined,
              { apiBaseUrl: url, credentialStore: store },
            )
          ).exitCode,
          2,
        );
        const commands = [
          [
            "run",
            "--environment",
            "development",
            "--process-id",
            processId,
            "--process-version-id",
            processVersionId,
          ],
          [
            "runs",
            "list",
            "--environment",
            "development",
            "--case-id",
            caseId,
            "--revision",
            "1",
          ],
          [
            "runs",
            "inspect",
            "--environment",
            "development",
            "--case-id",
            caseId,
            "--revision",
            "1",
            "--execution-id",
            "execution-1",
          ],
          [
            "runs",
            "logs",
            "--environment",
            "development",
            "--case-id",
            caseId,
            "--revision",
            "1",
            "--execution-id",
            "execution-1",
          ],
        ];
        for (const args of commands) {
          const streams = io(root);
          const result = await execute(args, streams.value, undefined, {
            apiBaseUrl: url,
            credentialStore: store,
          });
          assert.equal(result.exitCode, 0, args.join(" "));
          assert.equal(
            JSON.parse(streams.stdout.join("")).requestId,
            `req_${"1".repeat(26)}`,
          );
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

test("promotion and rollback use session auth, while missing session returns an authorization URL without mutation", async () => {
  const bearerOnly = new MemoryCredentialStore();
  bearerOnly.value = {
    schemaVersion: "preprocess.auth/v1",
    accessToken: "bearer-only-access-token",
    expiresAt: Date.now() + 3_600_000,
  };
  let mutations = 0;
  await withServer(
    (request, response) => {
      mutations += 1;
      assert.match(request.headers.cookie, /^preprocess_session=/);
      assert.equal(request.headers["x-csrf-token"], "csrf-token-secret");
      if (request.url.endsWith("/promotions"))
        return json(response, 200, {
          deployment: {
            processId,
            processVersionId,
            environment: "development",
            contentDigest: digest,
            scriptName: "process-version",
            capabilityDigest: digest,
            bindingDigest: digest,
            state: "deployed",
            deploymentRef: "deployment-1",
            errorCode: null,
            deployedAt: timestamp,
          },
          activation: activation(),
        });
      return json(response, 200, activation());
    },
    async ({ url }) => {
      const root = mkdtempSync(join(tmpdir(), "preprocess-promotion-"));
      try {
        const stopped = io(root);
        const stoppedResult = await execute(
          [
            "promote",
            "--process-id",
            processId,
            "--process-version-id",
            processVersionId,
            "--environment",
            "production",
          ],
          stopped.value,
          undefined,
          {
            apiBaseUrl: url,
            authBaseUrl: "https://auth.preprocess.com",
            credentialStore: bearerOnly,
          },
        );
        assert.equal(stoppedResult.exitCode, 3);
        assert.match(
          JSON.parse(stopped.stdout.join("")).authorizationUrl,
          /^https:\/\/auth\.preprocess\.com\/authorize/,
        );
        assert.equal(mutations, 0);

        const sessionStore = new MemoryCredentialStore();
        sessionStore.value = {
          ...bearerOnly.value,
          sessionCookie: "session-cookie-secret",
          csrfToken: "csrf-token-secret",
        };
        for (const args of [
          [
            "promote",
            "--process-id",
            processId,
            "--process-version-id",
            processVersionId,
            "--environment",
            "development",
          ],
          [
            "rollback",
            "--process-id",
            processId,
            "--environment",
            "development",
          ],
        ]) {
          const streams = io(root);
          assert.equal(
            (
              await execute(args, streams.value, undefined, {
                apiBaseUrl: url,
                credentialStore: sessionStore,
              })
            ).exitCode,
            0,
          );
        }
        assert.equal(mutations, 2);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

test("remote retries, cancellation, compatibility, ambiguity, and non-disclosing authorization use stable exits", async () => {
  const store = new MemoryCredentialStore();
  store.value = {
    schemaVersion: "preprocess.auth/v1",
    accessToken: "remote-access-token-secret",
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  const clock = new ImmediateClock();
  let attempts = 0;
  await withServer(
    (_request, response) => {
      attempts += 1;
      if (attempts < 3)
        return json(
          response,
          503,
          {
            error: {
              code: "PP_UNAVAILABLE",
              message: "temporary",
              status: 503,
            },
          },
          { "retry-after": "0" },
        );
      return json(response, 200, {
        principal: { kind: "user", id: "user_01HABC" },
        organization: { id: "org_01HABC" },
        workspace: { id: workspaceId },
        environment: "development",
        capabilities: [],
      });
    },
    async ({ url }) => {
      const root = mkdtempSync(join(tmpdir(), "preprocess-retry-"));
      try {
        const streams = io(root);
        assert.equal(
          (
            await execute(
              ["auth", "whoami"],
              streams.value,
              undefined,
              {
                apiBaseUrl: url,
                credentialStore: store,
                clock,
              },
            )
          ).exitCode,
          0,
        );
        assert.equal(attempts, 3);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  const root = mkdtempSync(join(tmpdir(), "preprocess-errors-"));
  try {
    const incompatible = io(root);
    const incompatibleResult = await execute(
      ["auth", "whoami"],
      incompatible.value,
      undefined,
      {
        credentialStore: store,
        apiBaseUrl: "https://api.preprocess.com",
        fetch: async () =>
          new Response("{}", {
            status: 200,
            headers: {
              "preprocess-api-version": "2",
              "preprocess-request-id": `req_${"1".repeat(26)}`,
            },
          }),
      },
    );
    assert.equal(incompatibleResult.exitCode, 5);

    const hidden = io(root);
    const hiddenResult = await execute(
      ["auth", "whoami"],
      hidden.value,
      undefined,
      {
        credentialStore: store,
        fetch: async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "PP_NOT_FOUND",
                message: "secret process exists",
                status: 404,
              },
            }),
            {
              status: 404,
              headers: {
                "preprocess-request-id": `req_${"1".repeat(26)}`,
              },
            },
          ),
      },
    );
    assert.equal(hiddenResult.exitCode, 3);
    assert.doesNotMatch(hidden.stdout.join(""), /secret process exists/);

    const ambiguous = io(root);
    const ambiguousResult = await execute(
      [
        "run",
        "--environment",
        "development",
        "--process-id",
        processId,
        "--process-version-id",
        processVersionId,
      ],
      ambiguous.value,
      undefined,
      {
        credentialStore: store,
        clock,
        fetch: async () => {
          throw new TypeError("socket closed");
        },
      },
    );
    assert.equal(ambiguousResult.exitCode, 4);
    assert.equal(JSON.parse(ambiguous.stdout.join("")).ambiguous, true);

    const controller = new AbortController();
    controller.abort();
    let cancelledFetches = 0;
    const cancelled = io(root);
    const cancelledResult = await execute(
      ["auth", "whoami"],
      { ...cancelled.value, signal: controller.signal },
      undefined,
      {
        credentialStore: store,
        fetch: async () => {
          cancelledFetches += 1;
          throw new Error("must not run");
        },
      },
    );
    assert.equal(cancelledResult.exitCode, 2);
    assert.equal(cancelledFetches, 0);

    const strict = io(root);
    const strictResult = await execute(
      ["auth", "whoami"],
      strict.value,
      undefined,
      {
        credentialStore: store,
        fetch: async () =>
          new Response(
            JSON.stringify({
              principal: { kind: "user", id: "user_01HABC" },
              organization: { id: "org_01HABC" },
              workspace: { id: workspaceId },
              environment: "development",
              capabilities: [],
              access_token: "must-never-be-forwarded",
            }),
            {
              status: 200,
              headers: {
                "preprocess-request-id": `req_${"1".repeat(26)}`,
              },
            },
          ),
      },
    );
    assert.equal(strictResult.exitCode, 5);
    assert.doesNotMatch(strict.stdout.join(""), /must-never-be-forwarded/);

    const sessionStore = new MemoryCredentialStore();
    sessionStore.value = {
      ...store.value,
      sessionCookie: "session-cookie-secret",
      csrfToken: "csrf-token-secret",
    };
    const denied = io(root);
    const deniedResult = await execute(
      [
        "promote",
        "--process-id",
        processId,
        "--process-version-id",
        processVersionId,
        "--environment",
        "production",
      ],
      denied.value,
      undefined,
      {
        credentialStore: sessionStore,
        authBaseUrl: "https://auth.preprocess.com",
        fetch: async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "PP_PRODUCTION_AUTHORITY_REQUIRED",
                message: "Additional authority is required.",
                status: 403,
              },
            }),
            {
              status: 403,
              headers: {
                "preprocess-request-id": `req_${"1".repeat(26)}`,
              },
            },
          ),
      },
    );
    assert.equal(deniedResult.exitCode, 3);
    assert.match(
      JSON.parse(denied.stdout.join("")).authorizationUrl,
      /^https:\/\/auth\.preprocess\.com\/authorize/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
