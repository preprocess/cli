import { createHash } from "node:crypto";

import type { CliIo, CliResult } from "../../index.js";
import type { RemoteCommandContext } from "../../remote/context.js";
import type { HostedEnvironment } from "../../remote/types.js";
import { RemoteFailure } from "../../remote/types.js";
import { validateRollback } from "../../remote/resources.js";

export interface RollbackInput {
  readonly processId: string;
  readonly environment: HostedEnvironment;
  readonly idempotencyKey?: string;
}

export async function rollbackCommand(
  input: RollbackInput,
  io: CliIo,
  context: RemoteCommandContext,
): Promise<CliResult> {
  if (!/^proc_[0-9a-hjkmnp-tv-z]{26}$/.test(input.processId))
    throw new Error("rollback requires a valid --process-id.");
  let authentication;
  try {
    authentication = await context.authentication.session(io.signal);
  } catch (error) {
    throw new RemoteFailure(
      error instanceof Error ? error.message : "Authentication is required.",
      3,
      { code: "PP_AUTHENTICATION_REQUIRED" },
    );
  }
  if (!authentication) {
    const url = new URL("/authorize", `${context.authBaseUrl}/`);
    url.searchParams.set("client_id", "preprocess_cli");
    url.searchParams.set("action", "rollback");
    url.searchParams.set("process_id", input.processId);
    url.searchParams.set("environment", input.environment);
    return {
      exitCode: 3,
      value: {
        authorizationRequired: true,
        authorizationUrl: url.href,
      },
    };
  }
  const idempotencyKey =
    input.idempotencyKey ??
    `rollback:${createHash("sha256")
      .update(`${input.processId}:${input.environment}`)
      .digest("hex")}`;
  let response;
  try {
    response = await context.client.request({
      method: "POST",
      path: `/v1/processes/${encodeURIComponent(input.processId)}/rollbacks`,
      environment: input.environment,
      authentication,
      idempotencyKey,
      body: { environment: input.environment },
      signal: io.signal,
      validate: validateRollback,
    });
  } catch (error) {
    if (
      error instanceof RemoteFailure &&
      !error.details.authorizationUrl &&
      (error.exitCode === 3 ||
        /(?:CONSENT|AUTHORITY|CREDENTIAL|EGRESS|CAPABILITY|BINDING)/i.test(
          error.details.code,
        ))
    ) {
      const url = authorizationUrl(context, input);
      throw new RemoteFailure(error.message, 3, {
        ...error.details,
        authorizationUrl: url,
      });
    }
    throw error;
  }
  return {
    exitCode: 0,
    value: {
      rollback: response.value,
      requestId: response.requestId,
      idempotentReplay: response.idempotentReplay,
    },
  };
}

function authorizationUrl(
  context: RemoteCommandContext,
  input: RollbackInput,
): string {
  const url = new URL("/authorize", `${context.authBaseUrl}/`);
  url.searchParams.set("client_id", "preprocess_cli");
  url.searchParams.set("action", "rollback");
  url.searchParams.set("process_id", input.processId);
  url.searchParams.set("environment", input.environment);
  return url.href;
}
