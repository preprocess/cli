import { createHash } from "node:crypto";

import type { CliIo, CliResult } from "../../index.js";
import type { RemoteCommandContext } from "../../remote/context.js";
import type { HostedEnvironment } from "../../remote/types.js";
import { RemoteFailure } from "../../remote/types.js";
import { validateHostedRun } from "../../remote/resources.js";

export interface HostedRunInput {
  readonly processId: string;
  readonly processVersionId: string;
  readonly environment: HostedEnvironment;
  readonly fixture?: unknown;
  readonly idempotencyKey?: string;
}

export async function hostedRunCommand(
  input: HostedRunInput,
  io: CliIo,
  context: RemoteCommandContext,
): Promise<CliResult> {
  validateTypeId(input.processId, "proc", "--process-id");
  validateTypeId(
    input.processVersionId,
    "procv",
    "--process-version-id",
  );
  const body = {
    processId: input.processId,
    processVersionId: input.processVersionId,
    environment: input.environment,
    ...(input.fixture === undefined ? {} : { fixture: input.fixture }),
  };
  const idempotencyKey =
    input.idempotencyKey ??
    `run:${createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex")}`;
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
    path: "/v1/test-runs",
    environment: input.environment,
    authentication,
    idempotencyKey,
    body,
    signal: io.signal,
    validate: validateHostedRun,
  });
  if (
    response.value.processId !== input.processId ||
    response.value.processVersionId !== input.processVersionId ||
    response.value.environment !== input.environment
  )
    throw new RemoteFailure(
      "Hosted run identity did not match the request.",
      4,
      { code: "PP_API_RESPONSE_INVALID", requestId: response.requestId },
    );
  return {
    exitCode: 0,
    value: {
      run: response.value,
      requestId: response.requestId,
      idempotentReplay: response.idempotentReplay,
    },
  };
}

function validateTypeId(value: string, prefix: string, option: string): void {
  if (!new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{26}$`).test(value))
    throw new Error(`Hosted run requires a valid ${option}.`);
}
