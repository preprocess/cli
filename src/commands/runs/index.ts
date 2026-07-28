import type { CliIo, CliResult } from "../../index.js";
import type { RemoteCommandContext } from "../../remote/context.js";
import type { HostedEnvironment } from "../../remote/types.js";
import { RemoteFailure } from "../../remote/types.js";
import {
  validateExecutionDetail,
  validateExecutionLogs,
  validateExecutionPage,
} from "../../remote/resources.js";
import { isTypeId } from "../../remote/validate.js";

export interface RunsInput {
  readonly environment: HostedEnvironment;
  readonly caseId: string;
  readonly revision: number;
  readonly executionId?: string;
  readonly classification?: "standard" | "sensitive";
  readonly cursor?: string;
  readonly limit?: number;
}

export async function runsCommand(
  operation: "list" | "inspect" | "logs",
  input: RunsInput,
  io: CliIo,
  context: RemoteCommandContext,
): Promise<CliResult> {
  if (!isTypeId(input.caseId, "case"))
    throw new Error(`runs ${operation} requires a valid --case-id.`);
  if (!Number.isSafeInteger(input.revision) || input.revision < 1)
    throw new Error(`runs ${operation} requires a positive --revision.`);
  if (
    operation !== "list" &&
    (!input.executionId ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(input.executionId))
  )
    throw new Error(
      `runs ${operation} requires a valid --execution-id.`,
    );
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
  const query = new URLSearchParams({
    caseId: input.caseId,
    revision: String(input.revision),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.limit === undefined ? {} : { limit: String(input.limit) }),
    ...(operation === "logs" && input.classification
      ? { classification: input.classification }
      : {}),
  });
  const base =
    operation === "list"
      ? "/v1/executions"
      : `/v1/executions/${encodeURIComponent(input.executionId as string)}${
          operation === "logs" ? "/logs" : ""
        }`;
  const response = await context.client.request({
    method: "GET",
    path: `${base}?${query.toString()}`,
    environment: input.environment,
    authentication,
    signal: io.signal,
    validate:
      operation === "list"
        ? validateExecutionPage
        : operation === "inspect"
          ? validateExecutionDetail
          : validateExecutionLogs,
  });
  if (!matchesRequest(operation, response.value, input))
    throw new RemoteFailure(
      "Execution identity did not match the request.",
      4,
      { code: "PP_API_RESPONSE_INVALID", requestId: response.requestId },
    );
  return {
    exitCode: 0,
    value: {
      environment: input.environment,
      ...(operation === "list"
        ? { executions: response.value }
        : operation === "inspect"
          ? { execution: response.value }
          : { logs: response.value }),
      requestId: response.requestId,
    },
  };
}

function matchesRequest(
  operation: "list" | "inspect" | "logs",
  value: Readonly<Record<string, unknown>>,
  input: RunsInput,
): boolean {
  if (operation === "list") {
    const data = value.data;
    return (
      Array.isArray(data) &&
      data.every((item) => {
        const identity = (
          item as { readonly identity?: Readonly<Record<string, unknown>> }
        ).identity;
        if (!identity) return false;
        return (
          identity.caseId === input.caseId &&
          identity.caseRevision === input.revision
        );
      })
    );
  }
  if (operation === "inspect") {
    const identity = value.identity as
      | Readonly<Record<string, unknown>>
      | undefined;
    if (!identity) return false;
    return (
      identity.id === input.executionId &&
      identity.caseId === input.caseId &&
      identity.caseRevision === input.revision
    );
  }
  return (
    value.executionId === input.executionId &&
    value.caseId === input.caseId &&
    value.revision === input.revision &&
    (input.classification === undefined ||
      value.classification === input.classification)
  );
}
