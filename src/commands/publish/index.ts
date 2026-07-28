import { createHash } from "node:crypto";

import type { CliIo, CliResult, CompilationResult } from "../../index.js";
import type { RemoteCommandContext } from "../../remote/context.js";
import { RemoteFailure } from "../../remote/types.js";
import { validateProcessVersion } from "../../remote/resources.js";
import { isTypeId } from "../../remote/validate.js";

const digestPattern = /^sha256:[a-f0-9]{64}$/;

export interface PublishInput {
  readonly processId: string;
  readonly version: string;
  readonly compilation: CompilationResult;
}

export async function publishCommand(
  input: PublishInput,
  io: CliIo,
  context: RemoteCommandContext,
): Promise<CliResult> {
  const { compilation } = input;
  if (
    !compilation.ok ||
    !compilation.manifest ||
    !compilation.package ||
    !compilation.packageBytes
  )
    throw new Error("A successful compiler artifact is required.");
  validateProcessId(input.processId);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(input.version))
    throw new Error("publish requires a valid semantic --version.");
  const packageDigest = compilation.manifest.digests?.package;
  const packageValue = compilation.package as Readonly<Record<string, unknown>>;
  const manifestDigest = packageValue.manifestDigest;
  if (
    !packageDigest ||
    !digestPattern.test(packageDigest) ||
    typeof manifestDigest !== "string" ||
    !digestPattern.test(manifestDigest)
  )
    throw new Error("The compiler artifact omitted canonical digests.");
  const exactDigest = `sha256:${createHash("sha256")
    .update(compilation.packageBytes)
    .digest("hex")}`;
  if (exactDigest !== packageDigest)
    throw new Error("The compiler package bytes do not match their digest.");
  const idempotencyKey = `publish:${input.processId}:${input.version}:${packageDigest}`;
  let authentication;
  try {
    authentication = await context.authentication.bearer(io.signal);
  } catch (error) {
    throw new RemoteFailure(
      error instanceof Error ? error.message : "Authentication is required.",
      3,
      { code: "PP_AUTHENTICATION_REQUIRED" },
    );
  }
  const response = await context.client.request({
    method: "POST",
    path: `/v1/processes/${encodeURIComponent(input.processId)}/versions`,
    authentication,
    idempotencyKey,
    body: {
      version: input.version,
      manifest: compilation.manifest,
      packageBase64: Buffer.from(compilation.packageBytes).toString("base64"),
      packageDigest,
      manifestDigest,
      testSummary: { passed: true, tests: 0, failures: [] },
    },
    signal: io.signal,
    validate: validateProcessVersion,
  });
  if (
    response.value.processId !== input.processId ||
    response.value.version !== input.version ||
    response.value.manifestDigest !== manifestDigest
  )
    throw new RemoteFailure(
      "Published version identity did not match the compiler artifact.",
      4,
      { code: "PP_API_RESPONSE_INVALID", requestId: response.requestId },
    );
  return {
    exitCode: 0,
    value: {
      processVersion: response.value,
      requestId: response.requestId,
      idempotentReplay: response.idempotentReplay,
    },
  };
}

function validateProcessId(value: string): void {
  if (!isTypeId(value, "proc"))
    throw new Error("publish requires a valid --process-id.");
}
