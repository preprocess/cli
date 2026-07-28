import { homedir } from "node:os";

import { AuthenticationSession } from "../auth/session.js";
import { SystemCredentialStore } from "../auth/store.js";
import { RemoteClient } from "./client.js";
import type { RemoteDependencies } from "./types.js";

export interface RemoteCommandContext {
  readonly client: RemoteClient;
  readonly authentication: AuthenticationSession;
  readonly authBaseUrl: string;
}

export function createRemoteCommandContext(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: RemoteDependencies = {},
): RemoteCommandContext {
  const resolved: RemoteDependencies = {
    ...dependencies,
    apiBaseUrl:
      dependencies.apiBaseUrl ??
      environment.PREPROCESS_API_URL ??
      "https://api.preprocess.com",
    authBaseUrl:
      dependencies.authBaseUrl ??
      environment.PREPROCESS_AUTH_URL ??
      "https://auth.preprocess.com",
    credentialStore:
      dependencies.credentialStore ??
      new SystemCredentialStore(environment.HOME ?? homedir()),
  };
  return {
    client: new RemoteClient(resolved),
    authentication: new AuthenticationSession(environment, resolved),
    authBaseUrl: resolved.authBaseUrl as string,
  };
}
