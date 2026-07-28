import type { CredentialStore, StoredCredential } from "./store.js";
import type {
  FetchLike,
  RemoteClock,
  RemoteDependencies,
} from "../remote/types.js";
import {
  exactKeys,
  httpsUrl,
  integerValue,
  optionalString,
  record,
  stringValue,
} from "../remote/validate.js";
import { readBoundedJsonResponse } from "../remote/body.js";

export interface DeviceAuthorization {
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly expiresIn: number;
  readonly interval: number;
}

export interface DeviceLoginResult {
  readonly authorization: DeviceAuthorization;
  readonly credential: StoredCredential;
}

interface InternalDeviceAuthorization extends DeviceAuthorization {
  readonly deviceCode: string;
}

class AuthClock implements RemoteClock {
  now(): number {
    return Date.now();
  }

  async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("Operation cancelled.");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("Operation cancelled."));
        },
        { once: true },
      );
    });
  }
}

function authBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1")
    throw new Error("Authentication base URL must be HTTPS.");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

async function authJson(
  fetcher: FetchLike,
  baseUrl: string,
  path: string,
  body: URLSearchParams,
  signal?: AbortSignal,
): Promise<{ readonly status: number; readonly value: unknown }> {
  const response = await fetcher(new URL(path, `${baseUrl}/`), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    ...(signal === undefined ? {} : { signal }),
  });
  const value = await readBoundedJsonResponse(
    response,
    256 * 1024,
    "Authentication response",
    signal,
  );
  return { status: response.status, value };
}

function validateAuthorization(value: unknown): InternalDeviceAuthorization {
  const result = record(value, "device authorization");
  exactKeys(
    result,
    [
      "device_code",
      "user_code",
      "verification_uri",
      "expires_in",
      "interval",
    ],
    ["verification_uri_complete"],
    "device authorization",
  );
  const verificationUrl =
    result.verification_uri_complete ?? result.verification_uri;
  return {
    deviceCode: stringValue(result.device_code, "device code", 4096),
    userCode: stringValue(result.user_code, "user code", 128),
    verificationUrl: httpsUrl(verificationUrl, "verification URL"),
    expiresIn: integerValue(result.expires_in, "device expiry", 1),
    interval: integerValue(result.interval, "device interval", 1),
  };
}

function validateToken(
  value: unknown,
  now: number,
  previousRefreshToken?: string,
): StoredCredential {
  const result = record(value, "token response");
  exactKeys(
    result,
    ["access_token", "token_type", "expires_in"],
    ["refresh_token", "session_cookie", "csrf_token"],
    "token response",
  );
  if (result.token_type !== "Bearer")
    throw new Error("Authentication service returned an invalid token type.");
  const refreshToken =
    optionalString(result.refresh_token, "refresh token", 16384) ??
    previousRefreshToken;
  return {
    schemaVersion: "preprocess.auth/v1",
    accessToken: stringValue(result.access_token, "access token", 16384),
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(result.session_cookie === undefined
      ? {}
      : {
          sessionCookie: stringValue(
            result.session_cookie,
            "session cookie",
            16384,
          ),
        }),
    ...(result.csrf_token === undefined
      ? {}
      : {
          csrfToken: stringValue(result.csrf_token, "CSRF token", 16384),
        }),
    expiresAt:
      now + integerValue(result.expires_in, "token expiry", 1) * 1000,
  };
}

function oauthError(value: unknown): string {
  const result = record(value, "OAuth error");
  return stringValue(result.error, "OAuth error", 128);
}

export class DeviceAuthenticator {
  readonly #fetch: FetchLike;
  readonly #clock: RemoteClock;
  readonly #baseUrl: string;
  readonly #store: CredentialStore;

  constructor(store: CredentialStore, dependencies: RemoteDependencies = {}) {
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#clock = dependencies.clock ?? new AuthClock();
    this.#baseUrl = authBaseUrl(
      dependencies.authBaseUrl ?? "https://auth.preprocess.com",
    );
    this.#store = store;
  }

  async login(
    signal?: AbortSignal,
    onAuthorization?: (authorization: DeviceAuthorization) => void,
  ): Promise<DeviceLoginResult> {
    const response = await authJson(
      this.#fetch,
      this.#baseUrl,
      "/oauth2/device_authorization",
      new URLSearchParams({
        client_id: "preprocess_cli",
        scope: "openid offline_access",
      }),
      signal,
    );
    if (response.status !== 200)
      throw new Error("Device authorization could not be started.");
    const authorization = validateAuthorization(response.value);
    onAuthorization?.({
      userCode: authorization.userCode,
      verificationUrl: authorization.verificationUrl,
      expiresIn: authorization.expiresIn,
      interval: authorization.interval,
    });
    const deadline = this.#clock.now() + authorization.expiresIn * 1000;
    let interval = authorization.interval * 1000;
    while (this.#clock.now() < deadline) {
      await this.#clock.sleep(interval, signal);
      const token = await authJson(
        this.#fetch,
        this.#baseUrl,
        "/oauth2/token",
        new URLSearchParams({
          client_id: "preprocess_cli",
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: authorization.deviceCode,
        }),
        signal,
      );
      if (token.status === 200) {
        const credential = validateToken(token.value, this.#clock.now());
        await this.#store.save(credential);
        return {
          authorization: {
            userCode: authorization.userCode,
            verificationUrl: authorization.verificationUrl,
            expiresIn: authorization.expiresIn,
            interval: authorization.interval,
          },
          credential,
        };
      }
      const error = oauthError(token.value);
      if (error === "authorization_pending") continue;
      if (error === "slow_down") {
        interval += 5000;
        continue;
      }
      if (error === "expired_token" || error === "access_denied")
        throw new Error("Device authorization expired or was denied.");
      throw new Error("Device authorization failed.");
    }
    throw new Error("Device authorization expired.");
  }

  async refresh(
    credential: StoredCredential,
    signal?: AbortSignal,
  ): Promise<StoredCredential> {
    if (!credential.refreshToken)
      throw new Error("Authentication expired; run `preprocess auth login`.");
    const response = await authJson(
      this.#fetch,
      this.#baseUrl,
      "/oauth2/token",
      new URLSearchParams({
        client_id: "preprocess_cli",
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
      }),
      signal,
    );
    if (response.status !== 200)
      throw new Error("Authentication expired; run `preprocess auth login`.");
    const refreshed = validateToken(
      response.value,
      this.#clock.now(),
      credential.refreshToken,
    );
    await this.#store.save(refreshed);
    return refreshed;
  }
}
