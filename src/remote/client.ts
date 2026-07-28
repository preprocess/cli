import {
  RemoteFailure,
  type RemoteClock,
  type RemoteDependencies,
  type RemoteRequest,
  type RemoteResponse,
} from "./types.js";
import {
  exactKeys,
  integerValue,
  record,
  stringValue,
  typeId,
} from "./validate.js";
import { readBoundedJsonResponse } from "./body.js";

const API_VERSION = "1";
const maximumResponseBytes = 2 * 1024 * 1024;
const safeHeaderPattern = /^[\x20-\x7e]+$/;

interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly status: number;
  readonly requestId: string;
}

class SystemClock implements RemoteClock {
  now(): number {
    return Date.now();
  }

  async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(abortError());
        },
        { once: true },
      );
    });
  }
}

function abortError(): Error {
  const error = new Error("Operation cancelled.");
  error.name = "AbortError";
  return error;
}

function normalizeBaseUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an HTTPS URL.`);
  }
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1")
    throw new Error(`${label} must be an HTTPS URL.`);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

function validateHeader(value: string, label: string): string {
  if (!value || value.length > 4096 || !safeHeaderPattern.test(value))
    throw new Error(`Invalid ${label}.`);
  return value;
}

function validateCredentialHeader(value: string, label: string): string {
  const result = validateHeader(value, label);
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(result))
    throw new Error(`Invalid ${label}.`);
  return result;
}

function validateIdempotencyKey(value: string): string {
  if (value.length < 1 || value.length > 255 || !/^[\x21-\x7e]+$/.test(value))
    throw new Error("Invalid idempotency key.");
  return value;
}

function parseRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 60
    ? seconds
    : undefined;
}

function validateError(value: unknown, status: number): ApiError {
  const envelope = record(value, "error envelope");
  exactKeys(envelope, ["error"], [], "error envelope");
  const error = record(envelope.error, "error");
  exactKeys(
    error,
    ["code", "message", "status", "requestId"],
    ["issues"],
    "error",
  );
  const errorStatus = integerValue(error.status, "error status", 400);
  if (errorStatus > 599 || errorStatus !== status)
    throw new Error("The API returned an invalid error status.");
  if (error.issues !== undefined) {
    if (!Array.isArray(error.issues))
      throw new Error("The API returned invalid error issues.");
    for (const item of error.issues) {
      const issue = record(item, "error issue");
      exactKeys(issue, ["code", "message"], ["path"], "error issue");
      apiErrorCode(issue.code, "issue code");
      if (
        issue.path !== undefined &&
        (typeof issue.path !== "string" || !issue.path.startsWith("/"))
      )
        throw new Error("The API returned an invalid issue path.");
      nonEmptyString(issue.message, "issue message");
    }
  }
  return {
    code: apiErrorCode(error.code, "error code"),
    message: nonEmptyString(error.message, "error message"),
    status,
    requestId: typeId(error.requestId, "req"),
  };
}

function apiErrorCode(value: unknown, label: string): string {
  const result = nonEmptyString(value, label);
  if (!/^PP_[A-Z][A-Z0-9_]*$/.test(result))
    throw new Error(`The API returned an invalid ${label}.`);
  return result;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1)
    throw new Error(`The API returned an invalid ${label}.`);
  return value;
}

function exitCodeForStatus(status: number): 1 | 3 | 4 {
  if (status === 401 || status === 403 || status === 404) return 3;
  if (status === 400 || status === 409 || status === 422) return 1;
  return 4;
}

function publicErrorMessage(error: ApiError): string {
  return error.status === 401 || error.status === 403 || error.status === 404
    ? "Authentication or authorization failed; the resource may be unavailable."
    : error.message;
}

export class RemoteClient {
  readonly #fetch: typeof fetch;
  readonly #clock: RemoteClock;
  readonly #apiBaseUrl: string;

  constructor(dependencies: RemoteDependencies = {}) {
    this.#fetch = (dependencies.fetch ?? globalThis.fetch) as typeof fetch;
    this.#clock = dependencies.clock ?? new SystemClock();
    this.#apiBaseUrl = normalizeBaseUrl(
      dependencies.apiBaseUrl ?? "https://api.preprocess.com",
      "API base URL",
    );
  }

  async request<T>(request: RemoteRequest<T>): Promise<RemoteResponse<T>> {
    const url = new URL(request.path, `${this.#apiBaseUrl}/`);
    if (url.origin !== new URL(this.#apiBaseUrl).origin)
      throw new Error("Remote request path escapes the API origin.");
    const headers = new Headers({
      Accept: "application/json",
      "Preprocess-Api-Version": API_VERSION,
      "Preprocess-Cli-Schema": "preprocess.cli/v1",
    });
    if (request.environment)
      headers.set("Preprocess-Environment", request.environment);
    if (request.idempotencyKey)
      headers.set(
        "Idempotency-Key",
        validateIdempotencyKey(request.idempotencyKey),
      );
    if (request.authentication?.kind === "bearer") {
      headers.set(
        "Authorization",
        `Bearer ${validateCredentialHeader(
          request.authentication.secret,
          "access token",
        )}`,
      );
    } else if (request.authentication?.kind === "session") {
      headers.set(
        "Cookie",
        `preprocess_session=${validateCredentialHeader(
          request.authentication.secret,
          "session",
        )}`,
      );
      if (request.authentication.csrfToken)
        headers.set(
          "X-CSRF-Token",
          validateCredentialHeader(
            request.authentication.csrfToken,
            "CSRF token",
          ),
        );
    }
    const body =
      request.body === undefined ? undefined : JSON.stringify(request.body);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const retryable =
      request.method === "GET" || request.idempotencyKey !== undefined;
    let lastNetworkFailure = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (request.signal?.aborted) throw abortError();
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
      } catch (error) {
        if (request.signal?.aborted || (error as { name?: unknown }).name === "AbortError")
          throw abortError();
        lastNetworkFailure = true;
        if (!retryable || attempt === 2)
          throw new RemoteFailure("The remote request did not complete.", 4, {
            code: "PP_REMOTE_NETWORK",
            ...(request.method === "POST" ? { ambiguous: true } : {}),
          });
        await this.#clock.sleep(100 * 2 ** attempt, request.signal);
        continue;
      }
      const responseVersion = response.headers.get("preprocess-api-version");
      if (responseVersion !== null && responseVersion !== API_VERSION)
        throw new RemoteFailure(
          "The platform API version is incompatible with this CLI.",
          5,
          { code: "PP_API_VERSION_INCOMPATIBLE" },
        );
      const rawRequestId = response.headers.get("preprocess-request-id");
      let requestId: string;
      try {
        requestId = typeId(rawRequestId, "req");
      } catch {
        throw new RemoteFailure(
          "The platform response omitted a valid request identifier.",
          4,
          { code: "PP_API_RESPONSE_INVALID" },
        );
      }
      let responseValue: unknown;
      try {
        responseValue = await readBoundedJsonResponse(
          response,
          maximumResponseBytes,
          "The platform response",
          request.signal,
        );
      } catch (error) {
        if (
          request.signal?.aborted ||
          (error as { name?: unknown }).name === "AbortError"
        )
          throw abortError();
        throw new RemoteFailure(
          error instanceof Error
            ? error.message
            : "The platform returned an invalid response.",
          4,
          {
            code: "PP_API_RESPONSE_INVALID",
            requestId,
          },
        );
      }
      if (!response.ok) {
        let apiError: ApiError;
        try {
          apiError = validateError(responseValue, response.status);
        } catch {
          throw new RemoteFailure(
            "The platform returned an invalid error response.",
            4,
            { code: "PP_API_RESPONSE_INVALID", requestId },
          );
        }
        if (apiError.requestId !== requestId)
          throw new RemoteFailure(
            "The platform returned mismatched request identifiers.",
            4,
            { code: "PP_API_RESPONSE_INVALID", requestId },
          );
        const retryAfterSeconds = parseRetryAfter(response);
        if (
          retryable &&
          attempt < 2 &&
          (response.status === 429 || response.status >= 500)
        ) {
          await this.#clock.sleep(
            (retryAfterSeconds ?? 0.1 * 2 ** attempt) * 1000,
            request.signal,
          );
          continue;
        }
        throw new RemoteFailure(
          publicErrorMessage(apiError),
          exitCodeForStatus(response.status),
          {
            code: apiError.code,
            requestId,
            httpStatus: response.status,
            ...(retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds }),
          },
        );
      }
      try {
        return {
          value: request.validate(responseValue),
          requestId,
          idempotentReplay:
            response.headers.get("idempotent-replay") === "true",
        };
      } catch (error) {
        const incompatible =
          error instanceof Error && /incompatible/i.test(error.message);
        throw new RemoteFailure(
          error instanceof Error
            ? error.message
            : "The platform returned an invalid response.",
          incompatible ? 5 : 4,
          {
            code: incompatible
              ? "PP_API_VERSION_INCOMPATIBLE"
              : "PP_API_RESPONSE_INVALID",
            requestId,
          },
        );
      }
    }
    throw new RemoteFailure("The remote request did not complete.", 4, {
      code: "PP_REMOTE_NETWORK",
      ...(lastNetworkFailure ? { ambiguous: true } : {}),
    });
  }
}
