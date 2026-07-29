import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distributionModules = [
  "auth/device",
  "auth/session",
  "auth/store",
  "commands/auth/index",
  "commands/promote/index",
  "commands/publish/index",
  "commands/rollback/index",
  "commands/run/index",
  "commands/runs/index",
  "index",
  "remote/body",
  "remote/client",
  "remote/context",
  "remote/resources",
  "remote/types",
  "remote/validate",
];

export const expectedPackageFiles = [
  "package/README.md",
  ...distributionModules.flatMap((module) =>
    [".d.ts", ".d.ts.map", ".js", ".js.map"].map(
      (extension) => `package/dist/${module}${extension}`,
    ),
  ),
  "package/package.json",
];

function isolatedEnvironment(cleanNpmConfig) {
  const environment = {
    ...process.env,
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_USERCONFIG: cleanNpmConfig,
  };
  delete environment.NODE_AUTH_TOKEN;
  delete environment.NPM_TOKEN;
  delete environment.NPM_CONFIG_TOKEN;
  return environment;
}

function run(command, arguments_, options = {}) {
  return execFileSync(command, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function jsonCommand(command, arguments_, options = {}) {
  const { allowFailure = false, ...runOptions } = options;
  try {
    return JSON.parse(run(command, arguments_, runOptions));
  } catch (error) {
    if (
      allowFailure &&
      error &&
      typeof error === "object" &&
      "stdout" in error &&
      typeof error.stdout === "string" &&
      error.stdout.length > 0
    ) {
      return JSON.parse(error.stdout);
    }
    throw error;
  }
}

export function createPackedTarball() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "preprocess-cli-pack-"));
  const cleanNpmConfig = join(temporaryDirectory, ".npmrc");
  writeFileSync(cleanNpmConfig, "registry=https://registry.npmjs.org/\n");
  const result = jsonCommand(
    "npm",
    ["pack", "--json", "--pack-destination", temporaryDirectory],
    { env: isolatedEnvironment(cleanNpmConfig) },
  );
  assert.equal(result.length, 1);
  return join(temporaryDirectory, result[0].filename);
}

export function verifyReleasePackage(tarball) {
  const absoluteTarball = resolve(tarball);
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "preprocess-cli-consumer-"),
  );
  try {
    const cleanNpmConfig = join(temporaryDirectory, ".npmrc");
    writeFileSync(cleanNpmConfig, "registry=https://registry.npmjs.org/\n");
    const environment = isolatedEnvironment(cleanNpmConfig);

    const inventory = run("tar", ["-tzf", absoluteTarball])
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort();
    assert.deepEqual(inventory, [...expectedPackageFiles].sort());

    const extractedDirectory = join(temporaryDirectory, "extracted");
    run("mkdir", ["-p", extractedDirectory]);
    run("tar", ["-xzf", absoluteTarball, "-C", extractedDirectory]);
    const packedManifestPath = join(
      extractedDirectory,
      "package",
      "package.json",
    );
    const packedManifestText = readFileSync(packedManifestPath, "utf8");
    const packedManifest = JSON.parse(packedManifestText);
    const expectedDependencies = {
      "@preprocess/compiler": "^1.0.0",
      "@preprocess/diagnostics": "^1.0.0",
      "@preprocess/harness": "^1.0.0",
      "@preprocess/project": "^1.0.0",
      "@preprocess/sdk": "^1.0.0",
    };

    assert.equal(packedManifest.name, "@preprocess/cli");
    assert.equal(packedManifest.version, "1.0.0");
    assert.equal(packedManifest.license, "UNLICENSED");
    assert.equal(packedManifest.private, undefined);
    assert.deepEqual(packedManifest.dependencies, expectedDependencies);
    assert.equal(packedManifest.optionalDependencies, undefined);
    assert.equal(packedManifest.peerDependencies, undefined);
    assert.equal(packedManifest.scripts?.preinstall, undefined);
    assert.equal(packedManifest.scripts?.install, undefined);
    assert.equal(packedManifest.scripts?.postinstall, undefined);
    assert.equal(packedManifest.bin?.preprocess, "./dist/index.js");
    assert.equal(packedManifest.publishConfig?.access, "public");
    assert.equal(packedManifest.publishConfig?.provenance, true);
    assert.equal(
      packedManifest.publishConfig?.registry,
      "https://registry.npmjs.org/",
    );
    assert.doesNotMatch(packedManifestText, /(?:workspace|file|link):/);
    assert.doesNotMatch(packedManifestText, /Users\/|home\/runner|[A-Z]:\\/);

    const consumerDirectory = join(temporaryDirectory, "consumer");
    run("mkdir", ["-p", consumerDirectory]);
    writeFileSync(
      join(consumerDirectory, "package.json"),
      JSON.stringify({
        name: "cli-release-probe",
        private: true,
        type: "module",
      }),
    );
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        absoluteTarball,
      ],
      { cwd: consumerDirectory, env: environment },
    );

    const binary = join(consumerDirectory, "node_modules", ".bin", "preprocess");
    const doctor = jsonCommand(binary, ["doctor", "--format", "json"], {
      cwd: consumerDirectory,
      env: environment,
    });
    assert.deepEqual(
      {
        schemaVersion: doctor.schemaVersion,
        cliVersion: doctor.cliVersion,
        ok: doctor.ok,
        contracts: doctor.contracts,
      },
      {
        schemaVersion: "preprocess.cli/v1",
        cliVersion: "1.0.0",
        ok: true,
        contracts: {
          project: "preprocess.project/v1",
          compiler: "1.0.0",
          harness: "1.0.0",
        },
      },
    );

    const processRoot = join(consumerDirectory, "release-process");
    const initialized = jsonCommand(
      binary,
      [
        "init",
        "--root",
        processRoot,
        "--project-key",
        "release-probe",
        "--name",
        "Release probe",
        "--format",
        "json",
      ],
      { cwd: consumerDirectory, env: environment },
    );
    assert.equal(initialized.ok, true);
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
      ],
      { cwd: processRoot, env: environment },
    );
    const discovered = jsonCommand(binary, ["discover", "--format", "json"], {
      cwd: processRoot,
      env: environment,
    });
    assert.equal(discovered.ok, true);
    assert.equal(discovered.projectKey, "release-probe");
    const checked = jsonCommand(
      binary,
      ["check", "--run-id", "release-check", "--format", "json"],
      { cwd: processRoot, env: environment },
    );
    assert.equal(checked.ok, true);
    const tested = jsonCommand(
      binary,
      ["test", "--run-id", "release-test", "--format", "json"],
      { cwd: processRoot, env: environment, allowFailure: true },
    );
    assert.equal(tested.ok, false);
    assert.equal(tested.code, "PP_EXECUTION_UNSUPPORTED");

    return {
      name: packedManifest.name,
      version: packedManifest.version,
      dependencies: packedManifest.dependencies,
      inventory,
      probes: ["doctor", "init", "discover", "check", "test-fail-closed"],
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tarball = process.argv[2] ?? createPackedTarball();
  process.stdout.write(
    `${JSON.stringify(verifyReleasePackage(tarball), null, 2)}\n`,
  );
}
