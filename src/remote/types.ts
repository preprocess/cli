import type { ExitCode } from "../index.js";

export type HostedEnvironment = "development" | "production";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface RemoteClock {
  now(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export interface RequestAuthentication {
  readonly kind: "bearer" | "session";
  readonly secret: string;
  readonly csrfToken?: string;
}

export interface RemoteRequest<T> {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly environment?: HostedEnvironment;
  readonly authentication?: RequestAuthentication;
  readonly idempotencyKey?: string;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal | undefined;
  readonly validate: (value: unknown) => T;
}

export interface RemoteResponse<T> {
  readonly value: T;
  readonly requestId: string;
  readonly idempotentReplay: boolean;
}

export interface RemoteErrorDetails {
  readonly code: string;
  readonly requestId?: string;
  readonly authorizationUrl?: string;
  readonly ambiguous?: boolean;
  readonly retryAfterSeconds?: number;
  readonly httpStatus?: number;
}

export class RemoteFailure extends Error {
  readonly exitCode: ExitCode;
  readonly details: RemoteErrorDetails;

  constructor(
    message: string,
    exitCode: ExitCode,
    details: RemoteErrorDetails,
  ) {
    super(message);
    this.name = "RemoteFailure";
    this.exitCode = exitCode;
    this.details = details;
  }
}

export interface RemoteDependencies {
  readonly fetch?: FetchLike;
  readonly clock?: RemoteClock;
  readonly apiBaseUrl?: string;
  readonly authBaseUrl?: string;
  readonly credentialStore?: import("../auth/store.js").CredentialStore;
}
