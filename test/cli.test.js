import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  CLI_SCHEMA_VERSION,
  CLI_VERSION,
  MCP_SCHEMA_VERSION,
  execute,
  serveMcp,
} from "../dist/index.js";

function diagnostics(items = []) {
  return { diagnostics: items, errorCount: items.length };
}

function contracts(overrides = {}) {
  const calls = { discover: 0, compile: 0, harness: [] };
  const value = {
    versions: {
      project: "preprocess.project/v1",
      compiler: "1.0.0",
      harness: "1.0.0",
    },
    discoverProcessProject(root) {
      calls.discover += 1;
      return {
        ok: true,
        project: {
          root,
          projectKey: "fixture-process",
          name: "Fixture Process",
          sdk: "^1.0.0",
          files: [],
          provenance: { kind: "local", dirty: false },
        },
        diagnostics: diagnostics(),
      };
    },
    compileProcess(root) {
      calls.compile += 1;
      return {
        ok: true,
        project: { root, projectKey: "fixture-process" },
        manifest: {
          projectKey: "fixture-process",
          capabilities: {},
          digests: { package: `sha256:${"a".repeat(64)}` },
        },
        package: {
          formatVersion: "preprocess.package/v1",
          contentDigest: `sha256:${"b".repeat(64)}`,
        },
        packageBytes: new Uint8Array(),
        diagnostics: diagnostics(),
      };
    },
    async runHarness(request) {
      calls.harness.push(request);
      return {
        ok: true,
        bundle: {
          schemaVersion: "preprocess.harness-run/v1",
          runId: request.runId,
          bundleDigest: `sha256:${"c".repeat(64)}`,
        },
        assertions: { passed: true, failures: [] },
        diagnostics: diagnostics(),
      };
    },
    ...overrides,
  };
  return { value, calls };
}

function io(root, { tty = false, stdin } = {}) {
  const stdout = [];
  const stderr = [];
  return {
    value: {
      stdout: {
        write(value) {
          stdout.push(String(value));
        },
      },
      stderr: {
        write(value) {
          stderr.push(String(value));
        },
      },
      ...(stdin ? { stdin } : {}),
      cwd: root,
      env: {},
      isTty: tty,
    },
    stdout,
    stderr,
  };
}

function temporaryProject() {
  const root = mkdtempSync(join(tmpdir(), "preprocess-cli-test-"));
  writeFileSync(join(root, "preprocess.config.ts"), "fixture");
  return root;
}

test("machine output is versioned and unknown commands use exit code 2", async () => {
  const root = temporaryProject();
  try {
    const fake = contracts();
    const streams = io(root);
    const result = await execute(
      ["unknown", "--format", "json"],
      streams.value,
      fake.value,
    );
    assert.equal(result.exitCode, 2);
    assert.equal(
      JSON.parse(streams.stdout.join("")).schemaVersion,
      CLI_SCHEMA_VERSION,
    );
    assert.equal(JSON.parse(streams.stdout.join("")).cliVersion, CLI_VERSION);
    assert.equal(fake.calls.compile, 0);
    const duplicate = io(root);
    assert.equal(
      (
        await execute(
          ["check", "--root", root, "--root", root],
          duplicate.value,
          fake.value,
        )
      ).exitCode,
      2,
    );
    const unknownOption = io(root);
    assert.equal(
      (await execute(["check", "--wat"], unknownOption.value, fake.value))
        .exitCode,
      2,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pretty, json, and jsonl preserve exit semantics and stream separation", async () => {
  const root = temporaryProject();
  try {
    const failing = contracts({
      compileProcess() {
        return {
          ok: false,
          diagnostics: diagnostics([
            { code: "AUT_CONFIG_SHAPE", message: "Malformed Process." },
          ]),
        };
      },
    });
    const pretty = io(root, { tty: true });
    const json = io(root);
    const jsonl = io(root);
    assert.equal(
      (
        await execute(
          ["check", "--format", "pretty"],
          pretty.value,
          failing.value,
        )
      ).exitCode,
      1,
    );
    assert.equal(
      (await execute(["check", "--format", "json"], json.value, failing.value))
        .exitCode,
      1,
    );
    assert.equal(
      (
        await execute(
          ["check", "--format", "jsonl"],
          jsonl.value,
          failing.value,
        )
      ).exitCode,
      1,
    );
    assert.match(pretty.stdout.join(""), /^✗ check/);
    assert.match(pretty.stderr.join(""), /Malformed Process/);
    assert.equal(json.stderr.join(""), "");
    assert.equal(JSON.parse(json.stdout.join("")).ok, false);
    assert.equal(JSON.parse(jsonl.stdout.join("")).type, "result");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incompatible shared contracts use stable exit code 5", async () => {
  const root = temporaryProject();
  try {
    const fake = contracts({
      compileProcess() {
        return {
          ok: false,
          diagnostics: diagnostics([
            { code: "AUT_COMPATIBILITY", message: "SDK is incompatible." },
          ]),
        };
      },
    });
    const streams = io(root);
    assert.equal(
      (await execute(["check"], streams.value, fake.value)).exitCode,
      5,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init is noninteractive and refuses overwrite before mutation", async () => {
  const parent = mkdtempSync(join(tmpdir(), "preprocess-cli-init-"));
  const root = join(parent, "sample");
  try {
    const fake = contracts();
    const first = io(parent);
    assert.equal(
      (
        await execute(
          [
            "init",
            "--root",
            root,
            "--project-key",
            "sample-process",
            "--name",
            "Sample Process",
          ],
          first.value,
          fake.value,
        )
      ).exitCode,
      0,
    );
    assert.match(
      readFileSync(join(root, "preprocess.config.ts"), "utf8"),
      /sample-process/,
    );
    assert.match(
      readFileSync(join(root, ".gitignore"), "utf8"),
      /\.preprocess\//,
    );
    const before = readFileSync(join(root, "schema.ts"), "utf8");
    const second = io(parent);
    assert.equal(
      (
        await execute(
          ["init", "--root", root, "--project-key", "other", "--name", "Other"],
          second.value,
          fake.value,
        )
      ).exitCode,
      2,
    );
    assert.equal(readFileSync(join(root, "schema.ts"), "utf8"), before);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("init does not require installed runtime contracts", async () => {
  const parent = mkdtempSync(join(tmpdir(), "preprocess-cli-standalone-init-"));
  const root = join(parent, "sample");
  try {
    const streams = io(parent);
    const result = await execute(
      [
        "init",
        "--root",
        root,
        "--project-key",
        "standalone",
        "--name",
        "Standalone",
      ],
      streams.value,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(
      JSON.parse(readFileSync(join(root, "fixtures", "basic.json"), "utf8"))
        .schemaVersion,
      "preprocess.harness-fixture/v1",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("doctor reports shared versions and scaffold view is overwrite-safe", async () => {
  const root = temporaryProject();
  try {
    const fake = contracts();
    const doctor = io(root);
    assert.equal(
      (await execute(["doctor"], doctor.value, fake.value)).exitCode,
      0,
    );
    assert.deepEqual(
      JSON.parse(doctor.stdout.join("")).contracts,
      fake.value.versions,
    );

    const scaffold = io(root);
    assert.equal(
      (await execute(["scaffold", "view"], scaffold.value, fake.value))
        .exitCode,
      0,
    );
    const content = readFileSync(join(root, "view.ts"), "utf8");
    const replay = io(root);
    assert.equal(
      (await execute(["scaffold", "view"], replay.value, fake.value)).exitCode,
      2,
    );
    assert.equal(readFileSync(join(root, "view.ts"), "utf8"), content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local commands delegate to shared contracts and persist predictable artifacts", async () => {
  const root = temporaryProject();
  try {
    const fake = contracts();
    for (const command of ["discover", "check", "test", "eval", "inspect"]) {
      const streams = io(root);
      const args = [command, "--root", root, "--format", "json"];
      if (["check", "test", "eval"].includes(command))
        args.push("--run-id", `${command}-run`);
      const result = await execute(args, streams.value, fake.value);
      assert.equal(result.exitCode, 0, command);
      assert.equal(JSON.parse(streams.stdout.join("")).command, command);
    }
    assert.equal(fake.calls.discover, 1);
    assert.equal(fake.calls.harness.length, 3);
    for (const command of ["check", "test", "eval"]) {
      assert.equal(
        JSON.parse(
          readFileSync(
            join(root, ".preprocess", "runs", `${command}-run`, "bundle.json"),
            "utf8",
          ),
        ).runId,
        `${command}-run`,
      );
      assert.equal(
        statSync(
          join(root, ".preprocess", "runs", `${command}-run`, "bundle.json"),
        ).mode & 0o777,
        0o600,
      );
    }
    const replay = io(root);
    assert.equal(
      (
        await execute(
          ["check", "--root", root, "--run-id", "check-run"],
          replay.value,
          fake.value,
        )
      ).exitCode,
      0,
    );
    const conflict = contracts({
      async runHarness(request) {
        return {
          ok: true,
          bundle: {
            schemaVersion: "preprocess.harness-run/v1",
            runId: request.runId,
            bundleDigest: `sha256:${"d".repeat(64)}`,
          },
          assertions: { passed: true, failures: [] },
          diagnostics: diagnostics(),
        };
      },
    });
    const conflictStreams = io(root);
    assert.equal(
      (
        await execute(
          ["check", "--root", root, "--run-id", "check-run"],
          conflictStreams.value,
          conflict.value,
        )
      ).exitCode,
      2,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run is local-only and replay requires a credential-free recording", async () => {
  const root = temporaryProject();
  try {
    const fake = contracts();
    const hosted = io(root);
    assert.equal(
      (
        await execute(
          ["run", "--environment", "development"],
          hosted.value,
          fake.value,
        )
      ).exitCode,
      2,
    );
    assert.equal(fake.calls.harness.length, 0);

    writeFileSync(
      join(root, "recording.json"),
      JSON.stringify({ authorized: true }),
    );
    const replay = io(root);
    assert.equal(
      (
        await execute(
          ["replay", "--recording", "recording.json", "--run-id", "replay-run"],
          replay.value,
          fake.value,
        )
      ).exitCode,
      0,
    );
    assert.equal(fake.calls.harness.at(-1).mode, "replay");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("eval performs bounded repeated runs and cancellation reaches no harness", async () => {
  const root = temporaryProject();
  try {
    const repeated = contracts();
    const streams = io(root);
    const result = await execute(
      ["eval", "--repetitions", "3", "--run-id", "quality"],
      streams.value,
      repeated.value,
    );
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(streams.stdout.join("")).evaluation.runIds, [
      "quality-001",
      "quality-002",
      "quality-003",
    ]);
    assert.equal(repeated.calls.harness.length, 3);

    const cancelled = contracts();
    const controller = new AbortController();
    controller.abort();
    const cancelledStreams = io(root);
    const cancelledResult = await execute(
      ["test"],
      { ...cancelledStreams.value, signal: controller.signal },
      cancelled.value,
    );
    assert.equal(cancelledResult.exitCode, 2);
    assert.equal(cancelled.calls.compile, 0);
    assert.equal(cancelled.calls.harness.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret-bearing fixture fails before compiler or harness access", async () => {
  const root = temporaryProject();
  const outside = mkdtempSync(join(tmpdir(), "preprocess-cli-outside-"));
  try {
    writeFileSync(
      join(root, "fixture.json"),
      JSON.stringify({ api_key: "abcdefghijklmnop" }),
    );
    const fake = contracts();
    const streams = io(root);
    assert.equal(
      (
        await execute(
          ["test", "--fixture", "fixture.json"],
          streams.value,
          fake.value,
        )
      ).exitCode,
      2,
    );
    assert.equal(fake.calls.compile, 0);
    assert.equal(fake.calls.harness.length, 0);
    writeFileSync(join(outside, "fixture.json"), "{}");
    const escaped = io(root);
    assert.equal(
      (
        await execute(
          ["test", "--fixture", join(outside, "fixture.json")],
          escaped.value,
          fake.value,
        )
      ).exitCode,
      2,
    );
    assert.equal(fake.calls.compile, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("diff compares shared compiler package identities", async () => {
  const left = temporaryProject();
  const right = temporaryProject();
  try {
    const fake = contracts();
    const streams = io(left);
    const result = await execute(
      ["diff", "--left", left, "--right", right],
      streams.value,
      fake.value,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(streams.stdout.join("")).equal, true);
    assert.equal(fake.calls.compile, 2);
  } finally {
    rmSync(left, { recursive: true, force: true });
    rmSync(right, { recursive: true, force: true });
  }
});

test("MCP exposes the documented tools and calls the same CLI contracts", async () => {
  const root = temporaryProject();
  try {
    mkdirSync(join(root, ".preprocess", "runs", "run_1"), { recursive: true });
    writeFileSync(
      join(root, ".preprocess", "runs", "run_1", "bundle.json"),
      JSON.stringify({ runId: "run_1", executionLog: { id: "log_1" } }),
    );
    async function* input() {
      yield `${JSON.stringify({ id: 1, method: "initialize" })}\n`;
      yield `${JSON.stringify({ id: 2, method: "tools/list" })}\n`;
      yield `${JSON.stringify({
        id: 3,
        method: "tools/call",
        params: { name: "project_discover", arguments: { root } },
      })}\n`;
      yield `${JSON.stringify({
        id: 4,
        method: "tools/call",
        params: {
          name: "execution_artifact_read",
          arguments: { root, runId: "run_1" },
        },
      })}\n`;
      yield `${JSON.stringify({
        id: 5,
        method: "tools/call",
        params: {
          name: "versions_diff",
          arguments: { left: root, right: root },
        },
      })}\n`;
      yield `${JSON.stringify({
        id: 6,
        method: "tools/call",
        params: {
          name: "versions_diff",
          arguments: { left: 42, right: root },
        },
      })}\n`;
      yield `not-json\n`;
    }
    const fake = contracts();
    const streams = io(root, { stdin: input() });
    await serveMcp(streams.value, fake.value);
    const responses = streams.stdout
      .join("")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(responses[0].result.schemaVersion, MCP_SCHEMA_VERSION);
    assert.deepEqual(
      responses[1].result.tools.map((tool) => tool.name),
      [
        "project_discover",
        "project_check",
        "tests_run",
        "replay_run",
        "versions_diff",
        "schema_inspect",
        "capabilities_inspect",
        "package_build",
        "package_publish",
        "execution_logs_query",
        "execution_artifact_read",
      ],
    );
    assert.equal(responses[2].result.ok, true);
    assert.equal(fake.calls.discover, 1);
    assert.equal(responses[3].result.value.runId, "run_1");
    assert.equal(responses[4].result.ok, true);
    assert.equal(responses[4].result.value.equal, true);
    assert.equal(responses[5].error.code, -32602);
    assert.match(responses[5].error.message, /left must be a string/);
    assert.equal(responses[6].error.code, -32602);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
