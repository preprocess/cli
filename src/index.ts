#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const CLI_SCHEMA_VERSION = "preprocess.cli/v1" as const;
export const MCP_SCHEMA_VERSION = "preprocess.mcp/v1" as const;

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5;
export type OutputFormat = "pretty" | "json" | "jsonl";

export interface Diagnostic {
  readonly code: string;
  readonly severity?: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}

export interface DiagnosticBundle {
  readonly diagnostics: readonly Diagnostic[];
  readonly errorCount: number;
}

export interface DiscoveryResult {
  readonly ok: boolean;
  readonly project?: {
    readonly root: string;
    readonly projectKey: string;
    readonly name: string;
    readonly sdk: string;
    readonly files: readonly {
      readonly path: string;
      readonly bytes: number;
    }[];
    readonly provenance: Readonly<Record<string, unknown>>;
  };
  readonly diagnostics: DiagnosticBundle;
}

export interface CompilationResult {
  readonly ok: boolean;
  readonly project?: DiscoveryResult["project"];
  readonly manifest?: Readonly<Record<string, unknown>> & {
    readonly projectKey?: string;
    readonly capabilities?: Readonly<Record<string, unknown>>;
    readonly digests?: Readonly<Record<string, string>>;
  };
  readonly package?: Readonly<Record<string, unknown>>;
  readonly packageBytes?: Uint8Array;
  readonly diagnostics: DiagnosticBundle;
}

export interface HarnessResult {
  readonly ok: boolean;
  readonly bundle?: Readonly<Record<string, unknown>> & {
    readonly runId?: string;
    readonly bundleDigest?: string;
  };
  readonly assertions?: {
    readonly passed: boolean;
    readonly failures: readonly string[];
  };
  readonly diagnostics: DiagnosticBundle;
}

export interface AuthoringContracts {
  discoverProcessProject(root: string): DiscoveryResult;
  compileProcess(root: string): CompilationResult;
  runHarness(
    request: Readonly<Record<string, unknown>>,
  ): Promise<HarnessResult>;
  readonly versions: {
    readonly project: string;
    readonly compiler: string;
    readonly harness: string;
  };
}

export interface CliIo {
  readonly stdout: { write(value: string): unknown };
  readonly stderr: { write(value: string): unknown };
  readonly stdin?: AsyncIterable<Uint8Array | string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isTty: boolean;
  readonly signal?: AbortSignal;
}

export interface CliResult {
  readonly exitCode: ExitCode;
  readonly value?: Readonly<Record<string, unknown>>;
}

interface ParsedArguments {
  readonly command: readonly string[];
  readonly options: Readonly<Record<string, string | boolean>>;
  readonly format: OutputFormat;
}

const secretPattern =
  /(?:api[_-]?key|client[_-]?secret|password|private[_-]?key|authorization)["']?\s*[:=]\s*["']?[A-Za-z0-9_+/=-]{12,}/i;
const secretKeyPattern =
  /^(?:api[_-]?key|client[_-]?secret|password|private[_-]?key|authorization|token)$/i;
const runIdPattern = /^[a-z0-9][a-z0-9_-]{0,127}$/;

class CliFailure extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.name = "CliFailure";
    this.exitCode = exitCode;
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Cannot canonicalize a non-finite number.");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  throw new TypeError(`Cannot canonicalize ${typeof value}`);
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function parseArguments(
  args: readonly string[],
  isTty: boolean,
): ParsedArguments {
  const command: string[] = [];
  const options: Record<string, string | boolean> = Object.create(
    null,
  ) as Record<string, string | boolean>;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] as string;
    if (!value.startsWith("--")) {
      command.push(value);
      continue;
    }
    const [rawName, inline] = value.slice(2).split("=", 2);
    if (!rawName) throw new Error("Empty option name.");
    if (Object.hasOwn(options, rawName))
      throw new Error(`Option --${rawName} was provided more than once.`);
    if (inline !== undefined) {
      options[rawName] = inline;
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options[rawName] = next;
      index += 1;
    } else {
      options[rawName] = true;
    }
  }
  const requested = options.format;
  const format =
    requested === undefined
      ? isTty
        ? "pretty"
        : "json"
      : requested === "pretty" || requested === "json" || requested === "jsonl"
        ? requested
        : undefined;
  if (!format) throw new Error("--format must be pretty, json, or jsonl.");
  return { command, options, format };
}

function option(
  parsed: ParsedArguments,
  name: string,
  fallback?: string,
): string | undefined {
  const value = parsed.options[name];
  return typeof value === "string" ? value : fallback;
}

function exactRoot(input: string): string {
  const root = realpathSync(resolve(input));
  if (root.split(sep).includes("node_modules"))
    throw new Error("Project roots inside node_modules are not permitted.");
  return root;
}

function projectInput(root: string, input: string): string {
  const path = realpathSync(resolve(root, input));
  if (path !== root && !path.startsWith(`${root}${sep}`))
    throw new Error("Input path escapes the Process project.");
  return path;
}

function readJson(path: string, maxBytes = 4 * 1024 * 1024): unknown {
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text) > maxBytes)
    throw new Error("Input exceeds the byte limit.");
  if (secretPattern.test(text))
    throw new Error("Secret-bearing input is not permitted.");
  const value = JSON.parse(text) as unknown;
  const inspect = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(inspect);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, item] of Object.entries(
      candidate as Readonly<Record<string, unknown>>,
    )) {
      if (secretKeyPattern.test(key))
        throw new Error("Secret-bearing input is not permitted.");
      inspect(item);
    }
  };
  inspect(value);
  return value;
}

function output(
  io: CliIo,
  format: OutputFormat,
  value: Readonly<Record<string, unknown>>,
): void {
  if (format === "pretty") {
    io.stdout.write(
      `${value.ok === true ? "✓" : "✗"} ${String(value.command)}\n`,
    );
    if (typeof value.summary === "string")
      io.stdout.write(`${value.summary}\n`);
    if (value.ok !== true) {
      if (typeof value.error === "string") io.stderr.write(`${value.error}\n`);
      if (Array.isArray(value.diagnostics)) {
        for (const item of value.diagnostics) {
          if (
            item &&
            typeof item === "object" &&
            typeof (item as { message?: unknown }).message === "string"
          )
            io.stderr.write(`${(item as { message: string }).message}\n`);
        }
      }
    }
    return;
  }
  if (format === "jsonl") {
    io.stdout.write(`${JSON.stringify({ type: "result", ...value })}\n`);
    return;
  }
  io.stdout.write(`${JSON.stringify(value)}\n`);
}

function envelope(
  command: string,
  ok: boolean,
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return { schemaVersion: CLI_SCHEMA_VERSION, command, ok, ...fields };
}

function diagnosticValue(
  command: string,
  diagnostics: DiagnosticBundle,
): Readonly<Record<string, unknown>> {
  return envelope(command, false, { diagnostics: diagnostics.diagnostics });
}

function diagnosticExitCode(diagnostics: DiagnosticBundle): ExitCode {
  return diagnostics.diagnostics.some((item) =>
    /(?:COMPATIBILITY|VERSION)/.test(item.code),
  )
    ? 5
    : 1;
}

function validateCommandShape(parsed: ParsedArguments): void {
  const [name, subcommand, ...extra] = parsed.command;
  if (
    extra.length > 0 ||
    (subcommand && !(name === "scaffold" && subcommand === "view"))
  )
    throw new Error("Unexpected positional arguments.");
  const key =
    name === "scaffold" ? `${name} ${subcommand ?? ""}` : (name ?? "help");
  const commandOptions: Readonly<Record<string, readonly string[]>> = {
    help: [],
    init: ["root", "project-key", "name"],
    doctor: [],
    discover: ["root"],
    check: ["root", "run-id"],
    test: ["root", "run-id", "fixture"],
    eval: ["root", "run-id", "fixture", "repetitions"],
    replay: ["root", "run-id", "recording"],
    run: ["root", "run-id", "fixture", "environment"],
    inspect: ["root"],
    diff: ["left", "right"],
    "scaffold view": ["root"],
    mcp: [],
  };
  const allowed = new Set(["format", ...(commandOptions[key] ?? [])]);
  for (const key of Object.keys(parsed.options)) {
    if (!allowed.has(key)) throw new Error(`Unknown option --${key}.`);
  }
}

async function dynamicContracts(): Promise<AuthoringContracts> {
  const projectName = "@preprocess/project";
  const compilerName = "@preprocess/compiler";
  const harnessName = "@preprocess/harness";
  try {
    const [project, compiler, harness] = await Promise.all([
      import(projectName),
      import(compilerName),
      import(harnessName),
    ]);
    const versions = {
      project: String(project.PROJECT_FORMAT_VERSION),
      compiler: String(compiler.COMPILER_VERSION),
      harness: String(harness.HARNESS_VERSION),
    };
    if (
      versions.project !== "preprocess.project/v1" ||
      versions.compiler !== "0.1.0" ||
      versions.harness !== "0.1.0"
    )
      throw new CliFailure(
        "The shared authoring contracts are incompatible.",
        5,
      );
    return {
      discoverProcessProject:
        project.discoverProcessProject as AuthoringContracts["discoverProcessProject"],
      compileProcess:
        compiler.compileProcess as AuthoringContracts["compileProcess"],
      runHarness: harness.runHarness as AuthoringContracts["runHarness"],
      versions,
    };
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw new Error(
      "The shared @preprocess/project, @preprocess/compiler, and @preprocess/harness contracts are unavailable.",
    );
  }
}

const unusedContracts: AuthoringContracts = Object.freeze({
  discoverProcessProject() {
    throw new Error("Shared authoring contracts are required.");
  },
  compileProcess() {
    throw new Error("Shared authoring contracts are required.");
  },
  async runHarness() {
    throw new Error("Shared authoring contracts are required.");
  },
  versions: { project: "unloaded", compiler: "unloaded", harness: "unloaded" },
});

function initProject(root: string, projectKey: string, name: string): void {
  const files: Readonly<Record<string, string>> = {
    "preprocess.config.ts": `import { defineProcess } from "@preprocess/sdk"\n\nexport default defineProcess({\n  projectKey: ${JSON.stringify(projectKey)},\n  name: ${JSON.stringify(name)},\n  sdk: "^1.0.0",\n})\n`,
    "schema.ts": `export default { fields: [] }\n`,
    "system.md": `You process ${name} accurately and cite the supplied evidence.\n`,
    "package.json": `${JSON.stringify(
      {
        name: projectKey,
        private: true,
        type: "module",
        dependencies: { "@preprocess/sdk": "^1.0.0" },
      },
      null,
      2,
    )}\n`,
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    ".gitignore": "node_modules/\ndist/\n.preprocess/\n",
    "fixtures/basic.json": `${JSON.stringify(
      {
        schemaVersion: "preprocess.harness-fixture/v1",
        name: "basic",
        artifacts: [],
        records: [],
        metadata: { agentVisible: {}, private: {} },
        assertions: { success: true, expectedOutcome: "succeeded" },
      },
      null,
      2,
    )}\n`,
  };
  if (existsSync(root) && readdirSync(root).some((entry) => entry !== ".git"))
    throw new Error("Refusing to initialize a non-empty directory.");
  for (const relative of Object.keys(files)) {
    if (existsSync(join(root, relative)))
      throw new Error(`Refusing to overwrite ${relative}.`);
  }
  mkdirSync(root, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { encoding: "utf8", mode: 0o644 });
  }
}

function stableRunId(command: string, root: string, seed?: string): string {
  if (seed !== undefined) {
    if (!runIdPattern.test(seed)) throw new Error("Invalid --run-id.");
    return seed;
  }
  return `${command}-${sha256(`${root}:${randomUUID()}`).slice(7, 23)}`;
}

function writeRun(
  root: string,
  runId: string,
  bundle: Readonly<Record<string, unknown>>,
  manifest?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  const directory = join(root, ".preprocess", "runs", runId);
  const bundleText = `${canonical(bundle)}\n`;
  const manifestText = `${canonical(manifest ?? {})}\n`;
  const references = {
    bundle: `.preprocess/runs/${runId}/bundle.json`,
    manifest: `.preprocess/runs/${runId}/manifest.json`,
  };
  const exactReplay = (): boolean => {
    try {
      return (
        readFileSync(join(directory, "bundle.json"), "utf8") === bundleText &&
        readFileSync(join(directory, "manifest.json"), "utf8") === manifestText
      );
    } catch {
      return false;
    }
  };
  mkdirSync(dirname(directory), { recursive: true });
  if (existsSync(directory)) {
    if (!exactReplay())
      throw new Error("Run identity conflicts with existing artifacts.");
    return references;
  }
  const temporary = `${directory}.tmp-${randomUUID()}`;
  mkdirSync(temporary, { recursive: false, mode: 0o700 });
  try {
    writeFileSync(join(temporary, "bundle.json"), bundleText, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    writeFileSync(join(temporary, "manifest.json"), manifestText, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      renameSync(temporary, directory);
    } catch (error) {
      if (!exactReplay()) throw error;
    }
    return references;
  } finally {
    if (existsSync(temporary))
      rmSync(temporary, { recursive: true, force: true });
  }
}

async function runHarnessCommand(
  name: string,
  parsed: ParsedArguments,
  io: CliIo,
  contracts: AuthoringContracts,
): Promise<CliResult> {
  if (io.signal?.aborted) throw new Error("Operation cancelled.");
  const root = exactRoot(option(parsed, "root", io.cwd) as string);
  const mode =
    name === "check"
      ? "static"
      : name === "replay"
        ? "replay"
        : name === "run"
          ? "fixture"
          : name === "eval"
            ? "fixture"
            : "fixture";
  if (name === "run" && option(parsed, "environment", "local") !== "local")
    return {
      exitCode: 2,
      value: envelope(name, false, {
        error: "PRE-66 supports only --environment local.",
      }),
    };
  const defaultFixture = join(root, "fixtures", "basic.json");
  const fixturePath = option(
    parsed,
    "fixture",
    ["test", "eval", "run"].includes(name) && existsSync(defaultFixture)
      ? "fixtures/basic.json"
      : undefined,
  );
  const recordingPath = option(parsed, "recording");
  const fixture = fixturePath
    ? readJson(projectInput(root, fixturePath))
    : undefined;
  const recording = recordingPath
    ? readJson(projectInput(root, recordingPath))
    : undefined;
  if (name === "replay" && !recording)
    throw new Error("replay requires --recording.");
  const runId = stableRunId(name, root, option(parsed, "run-id"));
  const compilation = contracts.compileProcess(root);
  if (!compilation.ok)
    return {
      exitCode: diagnosticExitCode(compilation.diagnostics),
      value: diagnosticValue(name, compilation.diagnostics),
    };
  const rawRepetitions =
    name === "eval" ? option(parsed, "repetitions", "1") : "1";
  const repetitions = Number(rawRepetitions);
  if (
    !Number.isSafeInteger(repetitions) ||
    repetitions < 1 ||
    repetitions > 100
  )
    throw new Error("--repetitions must be an integer from 1 to 100.");
  const runs: {
    readonly runId: string;
    readonly bundle: Readonly<Record<string, unknown>>;
    readonly assertions: HarnessResult["assertions"];
    readonly artifacts: Readonly<Record<string, string>>;
  }[] = [];
  for (let index = 0; index < repetitions; index += 1) {
    if (io.signal?.aborted) throw new Error("Operation cancelled.");
    const currentRunId =
      repetitions === 1
        ? runId
        : `${runId}-${String(index + 1).padStart(3, "0")}`;
    const result = await contracts.runHarness({
      root,
      mode,
      runId: currentRunId,
      processVersion: compilation.manifest?.digests?.package ?? "local",
      ...(fixture ? { fixture } : {}),
      ...(recording ? { recording } : {}),
      ...(name === "check" ? {} : { execution: deterministicExecution }),
    });
    if (io.signal?.aborted) throw new Error("Operation cancelled.");
    if (!result.ok)
      return {
        exitCode: diagnosticExitCode(result.diagnostics),
        value: diagnosticValue(name, result.diagnostics),
      };
    const bundle = result.bundle ?? {};
    runs.push({
      runId: currentRunId,
      bundle,
      assertions: result.assertions,
      artifacts: writeRun(root, currentRunId, bundle, compilation.manifest),
    });
  }
  const ok = runs.every((run) => run.assertions?.passed ?? true);
  const first = runs[0] as (typeof runs)[number];
  return {
    exitCode: ok ? 0 : 1,
    value: envelope(name, ok, {
      projectKey: compilation.manifest?.projectKey,
      runId: first.runId,
      bundle: first.bundle,
      assertions: first.assertions,
      artifacts: first.artifacts,
      ...(repetitions > 1
        ? {
            evaluation: {
              repetitions,
              passed: runs.filter((run) => run.assertions?.passed ?? true)
                .length,
              runIds: runs.map((run) => run.runId),
            },
          }
        : {}),
    }),
  };
}

const deterministicExecution = Object.freeze({
  async execute(): Promise<Readonly<Record<string, unknown>>> {
    return {
      result: {},
      success: true,
      outcome: "succeeded",
      schemaState: {
        valid: true,
        activeBranches: [],
        fieldStates: {},
        dynamicDomains: {},
      },
      evidenceCoverage: { required: [], covered: [] },
    };
  },
});

function inspectValue(root: string, contracts: AuthoringContracts): CliResult {
  const compilation = contracts.compileProcess(root);
  if (!compilation.ok)
    return {
      exitCode: 1,
      value: diagnosticValue("inspect", compilation.diagnostics),
    };
  return {
    exitCode: 0,
    value: envelope("inspect", true, {
      projectKey: compilation.manifest?.projectKey,
      manifest: compilation.manifest,
      package: compilation.package,
    }),
  };
}

async function dispatch(
  parsed: ParsedArguments,
  io: CliIo,
  contracts: AuthoringContracts,
): Promise<CliResult> {
  const [name, subcommand] = parsed.command;
  if (!name || name === "help") {
    return {
      exitCode: 0,
      value: envelope("help", true, {
        summary:
          "Commands: init doctor discover check test eval replay run inspect diff scaffold view mcp",
      }),
    };
  }
  if (name === "init") {
    const root = resolve(option(parsed, "root", io.cwd) as string);
    const projectKey = option(parsed, "project-key");
    const projectName = option(parsed, "name");
    if (!projectKey || !projectName)
      throw new Error("init requires --project-key and --name.");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(projectKey))
      throw new Error("Invalid --project-key.");
    initProject(root, projectKey, projectName);
    return { exitCode: 0, value: envelope(name, true, { projectKey, root }) };
  }
  if (name === "doctor") {
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 22)
      return {
        exitCode: 5,
        value: envelope(name, false, {
          error: "Node.js 22 or newer is required.",
        }),
      };
    return {
      exitCode: 0,
      value: envelope(name, true, {
        node: process.versions.node,
        contracts: contracts.versions,
        nonInteractive: true,
        network: "disabled",
      }),
    };
  }
  if (name === "discover") {
    const result = contracts.discoverProcessProject(
      exactRoot(option(parsed, "root", io.cwd) as string),
    );
    return result.ok
      ? {
          exitCode: 0,
          value: envelope(name, true, {
            projectKey: result.project?.projectKey,
            project: result.project,
          }),
        }
      : { exitCode: 1, value: diagnosticValue(name, result.diagnostics) };
  }
  if (["check", "test", "eval", "replay", "run"].includes(name))
    return runHarnessCommand(name, parsed, io, contracts);
  if (name === "inspect") {
    return inspectValue(
      exactRoot(option(parsed, "root", io.cwd) as string),
      contracts,
    );
  }
  if (name === "diff") {
    const left = option(parsed, "left");
    const right = option(parsed, "right");
    if (!left || !right) throw new Error("diff requires --left and --right.");
    const leftValue = inspectValue(exactRoot(left), contracts);
    const rightValue = inspectValue(exactRoot(right), contracts);
    if (leftValue.exitCode !== 0 || rightValue.exitCode !== 0)
      return {
        exitCode: 1,
        value: envelope(name, false, {
          left: leftValue.value,
          right: rightValue.value,
        }),
      };
    const leftDigest = (
      leftValue.value?.manifest as
        { digests?: { package?: string } } | undefined
    )?.digests?.package;
    const rightDigest = (
      rightValue.value?.manifest as
        { digests?: { package?: string } } | undefined
    )?.digests?.package;
    return {
      exitCode: 0,
      value: envelope(name, true, {
        equal: leftDigest === rightDigest,
        leftDigest,
        rightDigest,
      }),
    };
  }
  if (name === "scaffold" && subcommand === "view") {
    const root = exactRoot(option(parsed, "root", io.cwd) as string);
    const target = join(root, "view.ts");
    if (existsSync(target)) throw new Error("Refusing to overwrite view.ts.");
    writeFileSync(target, "export default { annotations: [] }\n", "utf8");
    return {
      exitCode: 0,
      value: envelope("scaffold view", true, { path: "view.ts" }),
    };
  }
  if (name === "mcp") {
    await serveMcp(io, contracts);
    return { exitCode: 0 };
  }
  throw new Error(`Unknown command: ${parsed.command.join(" ")}`);
}

const rootSchema = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 4096,
});
const mcpToolDefinitions = Object.freeze([
  {
    name: "project_discover",
    inputSchema: {
      type: "object",
      properties: { root: rootSchema },
      additionalProperties: false,
    },
  },
  {
    name: "project_check",
    inputSchema: {
      type: "object",
      properties: { root: rootSchema },
      additionalProperties: false,
    },
  },
  {
    name: "tests_run",
    inputSchema: {
      type: "object",
      properties: {
        root: rootSchema,
        fixture: { type: "string", minLength: 1, maxLength: 4096 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "replay_run",
    inputSchema: {
      type: "object",
      required: ["recording"],
      properties: {
        root: rootSchema,
        recording: { type: "string", minLength: 1, maxLength: 4096 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "versions_diff",
    inputSchema: {
      type: "object",
      required: ["left", "right"],
      properties: { left: rootSchema, right: rootSchema },
      additionalProperties: false,
    },
  },
  ...[
    "schema_inspect",
    "capabilities_inspect",
    "package_build",
    "package_publish",
  ].map((name) => ({
    name,
    inputSchema: {
      type: "object",
      properties: { root: rootSchema },
      additionalProperties: false,
    },
  })),
  {
    name: "execution_logs_query",
    inputSchema: {
      type: "object",
      required: ["runId"],
      properties: {
        root: rootSchema,
        runId: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,127}$" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "execution_artifact_read",
    inputSchema: {
      type: "object",
      required: ["runId"],
      properties: {
        root: rootSchema,
        runId: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,127}$" },
        artifact: { enum: ["bundle", "manifest"] },
      },
      additionalProperties: false,
    },
  },
] as const);
const mcpTools = Object.freeze(mcpToolDefinitions.map((tool) => tool.name));

function validateMcpArguments(
  input: unknown,
  schema: {
    readonly properties?: Readonly<
      Record<
        string,
        {
          readonly type?: string;
          readonly enum?: readonly string[];
          readonly minLength?: number;
          readonly maxLength?: number;
          readonly pattern?: string;
        }
      >
    >;
    readonly required?: readonly string[];
  },
): Readonly<Record<string, unknown>> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    throw new Error("MCP arguments must be an object.");
  const args = input as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(schema.properties ?? {}, key))
      throw new Error(`Unknown MCP argument ${key}.`);
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(args, key))
      throw new Error(`Missing MCP argument ${key}.`);
  }
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties?.[key];
    if (!property) continue;
    if (property.type === "string" && typeof value !== "string")
      throw new Error(`MCP argument ${key} must be a string.`);
    if (
      property.enum &&
      (typeof value !== "string" || !property.enum.includes(value))
    )
      throw new Error(`MCP argument ${key} is not an allowed value.`);
    if (typeof value === "string") {
      if (property.minLength !== undefined && value.length < property.minLength)
        throw new Error(`MCP argument ${key} is too short.`);
      if (property.maxLength !== undefined && value.length > property.maxLength)
        throw new Error(`MCP argument ${key} is too long.`);
      if (property.pattern && !new RegExp(property.pattern, "u").test(value))
        throw new Error(`MCP argument ${key} has an invalid format.`);
    }
  }
  return args;
}

export async function serveMcp(
  io: CliIo,
  contracts: AuthoringContracts,
): Promise<void> {
  if (!io.stdin) throw new Error("MCP requires stdin.");
  let pending = "";
  for await (const chunk of io.stdin) {
    pending +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(pending) > 1024 * 1024)
      throw new Error("MCP request exceeds the byte limit.");
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      let request: {
        readonly id?: string | number;
        readonly method?: string;
        readonly params?: Readonly<Record<string, unknown>>;
      } = {};
      try {
        request = JSON.parse(line) as typeof request;
        let result: unknown;
        if (request.method === "initialize") {
          result = { schemaVersion: MCP_SCHEMA_VERSION, tools: mcpTools };
        } else if (request.method === "tools/list") {
          result = { tools: mcpToolDefinitions };
        } else if (request.method === "tools/call") {
          result = await callMcpTool(request.params ?? {}, io, contracts);
        } else {
          io.stdout.write(
            `${JSON.stringify({ id: request.id, error: { code: -32601, message: "Method not found" } })}\n`,
          );
          continue;
        }
        io.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      } catch (error) {
        io.stdout.write(
          `${JSON.stringify({
            id: request.id ?? null,
            error: {
              code: -32602,
              message:
                error instanceof Error ? error.message : "Invalid request",
            },
          })}\n`,
        );
      }
    }
  }
}

async function callMcpTool(
  params: Readonly<Record<string, unknown>>,
  io: CliIo,
  contracts: AuthoringContracts,
): Promise<unknown> {
  const name = params.name;
  if (typeof name !== "string" || !mcpTools.includes(name))
    throw new Error("Unknown MCP tool.");
  const definition = mcpToolDefinitions.find((tool) => tool.name === name);
  const schema = definition?.inputSchema as
    | {
        readonly properties?: Readonly<
          Record<
            string,
            {
              readonly type?: string;
              readonly enum?: readonly string[];
              readonly minLength?: number;
              readonly maxLength?: number;
              readonly pattern?: string;
            }
          >
        >;
        readonly required?: readonly string[];
      }
    | undefined;
  if (!schema) throw new Error("MCP tool schema is unavailable.");
  const args = validateMcpArguments(params.arguments ?? {}, schema);
  if (name === "package_publish")
    return {
      schemaVersion: MCP_SCHEMA_VERSION,
      ok: false,
      unavailable: "PRE-67 hosted boundary",
    };
  if (name === "execution_artifact_read" || name === "execution_logs_query") {
    const root = exactRoot(typeof args.root === "string" ? args.root : io.cwd);
    const runId = args.runId;
    if (typeof runId !== "string" || !runIdPattern.test(runId))
      throw new Error("A valid runId is required.");
    const fileName =
      name === "execution_artifact_read" && args.artifact === "manifest"
        ? "manifest.json"
        : "bundle.json";
    const value = readJson(join(root, ".preprocess", "runs", runId, fileName));
    return name === "execution_logs_query"
      ? {
          schemaVersion: MCP_SCHEMA_VERSION,
          ok: true,
          runId,
          executionLog:
            value && typeof value === "object"
              ? ((value as Readonly<Record<string, unknown>>).executionLog ??
                null)
              : null,
        }
      : {
          schemaVersion: MCP_SCHEMA_VERSION,
          ok: true,
          runId,
          artifact: fileName,
          value,
        };
  }
  const root = typeof args.root === "string" ? args.root : io.cwd;
  const command =
    name === "project_discover"
      ? ["discover"]
      : name === "project_check"
        ? ["check"]
        : name === "tests_run"
          ? ["test"]
          : name === "replay_run"
            ? ["replay"]
            : name === "versions_diff"
              ? ["diff"]
              : ["inspect"];
  const cliArgs = [
    ...command,
    ...(name === "versions_diff" ? [] : ["--root", root]),
    "--format",
    "json",
    ...(typeof args.fixture === "string" ? ["--fixture", args.fixture] : []),
    ...(typeof args.recording === "string"
      ? ["--recording", args.recording]
      : []),
    ...(typeof args.left === "string" ? ["--left", args.left] : []),
    ...(typeof args.right === "string" ? ["--right", args.right] : []),
  ];
  const capture: string[] = [];
  const result = await execute(
    cliArgs,
    {
      ...io,
      stdout: {
        write(value: string) {
          capture.push(value);
        },
      },
    },
    contracts,
  );
  return {
    schemaVersion: MCP_SCHEMA_VERSION,
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    value: capture.length ? JSON.parse(capture.join("")) : result.value,
  };
}

export async function execute(
  args: readonly string[],
  io: CliIo,
  providedContracts?: AuthoringContracts,
): Promise<CliResult> {
  try {
    const parsed = parseArguments(args, io.isTty);
    validateCommandShape(parsed);
    const first = parsed.command[0];
    const contracts =
      providedContracts ??
      (!first || first === "help" || first === "init"
        ? unusedContracts
        : await dynamicContracts());
    const result = await dispatch(parsed, io, contracts);
    if (result.value) output(io, parsed.format, result.value);
    return result;
  } catch (error) {
    const value = envelope(args[0] ?? "help", false, {
      error: error instanceof Error ? error.message : "CLI failed.",
    });
    const format =
      args.includes("--format") &&
      args[args.indexOf("--format") + 1] === "pretty"
        ? "pretty"
        : "json";
    output(io, format, value);
    return {
      exitCode: error instanceof CliFailure ? error.exitCode : 2,
      value,
    };
  }
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<ExitCode> {
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await execute(args, {
      stdout: process.stdout,
      stderr: process.stderr,
      stdin: process.stdin,
      cwd: process.cwd(),
      env: process.env,
      isTty: Boolean(process.stdout.isTTY),
      signal: controller.signal,
    });
    return result.exitCode;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
