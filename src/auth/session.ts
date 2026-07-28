import { homedir } from "node:os";

import {
  SystemCredentialStore,
  type CredentialStore,
  type StoredCredential,
} from "./store.js";
import { DeviceAuthenticator } from "./device.js";
import type {
  RemoteDependencies,
  RequestAuthentication,
} from "../remote/types.js";

export class AuthenticationSession {
  readonly #store: CredentialStore;
  readonly #authenticator: DeviceAuthenticator;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #now: () => number;

  constructor(
    environment: Readonly<Record<string, string | undefined>>,
    dependencies: RemoteDependencies = {},
  ) {
    this.#environment = environment;
    this.#store =
      dependencies.credentialStore ??
      new SystemCredentialStore(environment.HOME ?? homedir());
    this.#authenticator = new DeviceAuthenticator(this.#store, dependencies);
    this.#now = dependencies.clock
      ? () => dependencies.clock!.now()
      : () => Date.now();
  }

  get authenticator(): DeviceAuthenticator {
    return this.#authenticator;
  }

  async credential(signal?: AbortSignal): Promise<StoredCredential> {
    const apiKey = this.#environment.PREPROCESS_API_KEY;
    if (apiKey) {
      return {
        schemaVersion: "preprocess.auth/v1",
        accessToken: apiKey,
        expiresAt: Number.MAX_SAFE_INTEGER,
      };
    }
    let credential = await this.#store.load();
    if (!credential)
      throw new Error("Authentication is required; run `preprocess auth login`.");
    if (credential.expiresAt <= this.#now() + 60_000)
      credential = await this.#authenticator.refresh(credential, signal);
    return credential;
  }

  async bearer(signal?: AbortSignal): Promise<RequestAuthentication> {
    const credential = await this.credential(signal);
    return { kind: "bearer", secret: credential.accessToken };
  }

  async session(signal?: AbortSignal): Promise<RequestAuthentication | null> {
    if (this.#environment.PREPROCESS_API_KEY) return null;
    const credential = await this.credential(signal);
    return credential.sessionCookie
      ? {
          kind: "session",
          secret: credential.sessionCookie,
          ...(credential.csrfToken
            ? { csrfToken: credential.csrfToken }
            : {}),
        }
      : null;
  }

  async logout(): Promise<void> {
    await this.#store.clear();
  }
}
