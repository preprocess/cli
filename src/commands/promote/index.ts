import { createHash } from "node:crypto";

import type { CliIo, CliResult } from "../../index.js";
import type { RemoteCommandContext } from "../../remote/context.js";
import type { HostedEnvironment } from "../../remote/types.js";
import { RemoteFailure } from "../../remote/types.js";
import { validatePromotion } from "../../remote/resources.js";
import { isTypeId } from "../../remote/validate.js";

export interface PromoteInput {
  readonly processId: string;
  readonly processVersionId: string;
  readonly environment: HostedEnvironment;
  readonly idempotencyKey?: string;
}

export async function promoteCommand(
  input: PromoteInput,
  io: CliIo,
  context: RemoteCommandContext,
): Promise<CliResult> {
  validateIds(input.processId, input.processVersionId);
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
  if (!authentication)
    return authorizationRequired(context, input, "promote");
  const idempotencyKey =
    input.idempotencyKey ??
    `promote:${createHash("sha256")
      .update(
        `${input.processId}:${input.processVersionId}:${input.environment}`,
      )
      .digest("hex")}`;
  let response;
  try {
    response = await context.client.request({
      method: "POST",
      path: `/v1/processes/${encodeURIComponent(input.processId)}/promotions`,
      environment: input.environment,
      authentication,
      idempotencyKey,
      body: {
        processVersionId: input.processVersionId,
        environment: input.environment,
      },
      signal: io.signal,
      validate: validatePromotion,
    });
  } catch (error) {
    throw authorizationFailure(error, context, input);
  }
  const deployment = response.value.deployment as
    | Readonly<Record<string, unknown>>
    | undefined;
  const activation = response.value.activation as
    | Readonly<Record<string, unknown>>
    | undefined;
  if (
    deployment?.processId !== input.processId ||
    deployment.processVersionId !== input.processVersionId ||
    deployment.environment !== input.environment ||
    activation?.processId !== input.processId ||
    activation.activeVersionId !== input.processVersionId ||
    activation.environment !== input.environment
  )
    throw new RemoteFailure(
      "Promotion identity did not match the request.",
      4,
      { code: "PP_API_RESPONSE_INVALID", requestId: response.requestId },
    );
  return {
    exitCode: 0,
    value: {
      promotion: response.value,
      requestId: response.requestId,
      idempotentReplay: response.idempotentReplay,
    },
  };
}

function authorizationRequired(
  context: RemoteCommandContext,
  input: PromoteInput,
  action: string,
): CliResult {
  const url = new URL("/authorize", `${context.authBaseUrl}/`);
  url.searchParams.set("client_id", "preprocess_cli");
  url.searchParams.set("action", action);
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

function authorizationFailure(
  error: unknown,
  context: RemoteCommandContext,
  input: PromoteInput,
): unknown {
  if (!(error instanceof RemoteFailure)) return error;
  const needsAuthorization =
    error.details.httpStatus === 401 ||
    error.details.httpStatus === 403 ||
    /(?:CONSENT|AUTHORITY|CREDENTIAL|EGRESS|CAPABILITY|BINDING)/i.test(
      error.details.code,
    );
  if (!needsAuthorization || error.details.authorizationUrl) return error;
  const required = authorizationRequired(context, input, "promote");
  return new RemoteFailure(error.message, 3, {
    ...error.details,
    authorizationUrl: required.value?.authorizationUrl as string,
  });
}

function validateIds(processId: string, processVersionId: string): void {
  if (!isTypeId(processId, "proc"))
    throw new Error("promote requires a valid --process-id.");
  if (!isTypeId(processVersionId, "procv"))
    throw new Error("promote requires a valid --process-version-id.");
}
