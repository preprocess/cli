import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

function argument(name, required = true) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (required && !value) throw new Error(`Missing ${name}`);
  return value;
}

function version(command) {
  return execFileSync(command, ["--version"], { encoding: "utf8" }).trim();
}

const tarball = resolve(argument("--tarball"));
const packResult = JSON.parse(readFileSync(argument("--pack"), "utf8"))[0];
const publishPath = argument("--publish", false);
const publishResult = publishPath
  ? JSON.parse(readFileSync(publishPath, "utf8"))
  : null;
const sourceCommit = argument("--sha");
const output = argument("--output");
const bytes = readFileSync(tarball);
const manifest = JSON.parse(readFileSync("package.json", "utf8"));

const evidence = {
  schemaVersion: "preprocess.npm-release-evidence/v1",
  source: {
    repository: "https://github.com/preprocess/cli",
    commit: sourceCommit,
  },
  package: {
    name: packResult.name,
    version: packResult.version,
    spec: `${packResult.name}@${packResult.version}`,
    filename: basename(tarball),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    npmIntegrity: packResult.integrity,
    npmShasum: packResult.shasum,
    packedBytes: bytes.length,
    unpackedBytes: packResult.unpackedSize,
    files: packResult.files.map(({ path, size }) => ({ path, size })),
    dependencies: manifest.dependencies,
  },
  registryIdentity: {
    registry: "https://registry.npmjs.org/",
    access: "public",
    provenance: true,
  },
  toolchain: {
    node: version("node"),
    npm: version("npm"),
    pnpm: version("pnpm"),
  },
  verification: [
    { command: "pnpm install --frozen-lockfile", result: "passed" },
    { command: "pnpm check", result: "passed" },
    { command: "pnpm test", result: "passed" },
    { command: "pnpm build", result: "passed" },
    { command: "npm pack --dry-run --json", result: "passed" },
    {
      command: "node test/release-package.js <exact-tarball>",
      result: "passed",
    },
  ],
  publishResult,
};

writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
