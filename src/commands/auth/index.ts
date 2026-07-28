import type { CliIo, CliResult } from "../../index.js";
import type { RemoteCommandContext } from "../../remote/context.js";
import { RemoteFailure } from "../../remote/types.js";
import { validateMe } from "../../remote/resources.js";

export async function loginCommand(
  io: CliIo,
  context: RemoteCommandContext,
): Promise<CliResult> {
  try {
    let announced:
      | { readonly userCode: string; readonly verificationUrl: string }
      | undefined;
    const result = await context.authentication.authenticator.login(
      io.signal,
      (authorization) => {
        announced = authorization;
        io.stderr.write(
          `Open ${authorization.verificationUrl} and enter code ${authorization.userCode}.\n`,
        );
      },
    );
    return {
      exitCode: 0,
      value: {
        authenticated: true,
        verificationUrl:
          announced?.verificationUrl ??
          result.authorization.verificationUrl,
        userCode: announced?.userCode ?? result.authorization.userCode,
      },
    };
  } catch (error) {
    throw authenticationFailure(error);
  }
}

export async function logoutCommand(
  context: RemoteCommandContext,
): Promise<CliResult> {
  await context.authentication.logout();
  return { exitCode: 0, value: { authenticated: false } };
}

export async function whoamiCommand(
  io: CliIo,
  context: RemoteCommandContext,
): Promise<CliResult> {
  try {
    const authentication = await context.authentication.bearer(io.signal);
    const response = await context.client.request({
      method: "GET",
      path: "/v1/me",
      authentication,
      signal: io.signal,
      validate: validateMe,
    });
    return {
      exitCode: 0,
      value: { identity: response.value, requestId: response.requestId },
    };
  } catch (error) {
    if (error instanceof RemoteFailure) throw error;
    throw authenticationFailure(error);
  }
}

function authenticationFailure(error: unknown): RemoteFailure {
  const cancelled =
    error instanceof Error &&
    (error.name === "AbortError" || /cancelled/i.test(error.message));
  return new RemoteFailure(
    cancelled
      ? "Operation cancelled."
      : error instanceof Error
        ? error.message
        : "Authentication failed.",
    cancelled ? 2 : 3,
    { code: cancelled ? "PP_CANCELLED" : "PP_AUTHENTICATION_REQUIRED" },
  );
}
