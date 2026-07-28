import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface StoredCredential {
  readonly schemaVersion: "preprocess.auth/v1";
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly sessionCookie?: string;
  readonly csrfToken?: string;
  readonly expiresAt: number;
}

export interface CredentialStore {
  load(): Promise<StoredCredential | null>;
  save(value: StoredCredential): Promise<void>;
  clear(): Promise<void>;
}

function validateSecret(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 12 ||
    value.length > 16384 ||
    /[\r\n\0]/.test(value)
  )
    throw new Error(`Stored ${label} is invalid.`);
  return value;
}

export function validateStoredCredential(value: unknown): StoredCredential {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Stored authentication is invalid.");
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "accessToken",
    "refreshToken",
    "sessionCookie",
    "csrfToken",
    "expiresAt",
  ]);
  if (
    record.schemaVersion !== "preprocess.auth/v1" ||
    Object.keys(record).some((key) => !allowed.has(key)) ||
    !Number.isSafeInteger(record.expiresAt) ||
    (record.expiresAt as number) < 0
  )
    throw new Error("Stored authentication is invalid.");
  return {
    schemaVersion: "preprocess.auth/v1",
    accessToken: validateSecret(record.accessToken, "access token"),
    ...(record.refreshToken === undefined
      ? {}
      : { refreshToken: validateSecret(record.refreshToken, "refresh token") }),
    ...(record.sessionCookie === undefined
      ? {}
      : { sessionCookie: validateSecret(record.sessionCookie, "session") }),
    ...(record.csrfToken === undefined
      ? {}
      : { csrfToken: validateSecret(record.csrfToken, "CSRF token") }),
    expiresAt: record.expiresAt as number,
  };
}

export class FileCredentialStore implements CredentialStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = resolve(path);
  }

  async load(): Promise<StoredCredential | null> {
    if (!existsSync(this.#path)) return null;
    const file = lstatSync(this.#path);
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0)
      throw new Error(
        "Authentication fallback file permissions are not restricted.",
      );
    return validateStoredCredential(
      JSON.parse(readFileSync(this.#path, "utf8")) as unknown,
    );
  }

  async save(value: StoredCredential): Promise<void> {
    const validated = validateStoredCredential(value);
    const directory = dirname(this.#path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temporary = join(directory, `.session-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(validated), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, this.#path);
      chmodSync(this.#path, 0o600);
    } finally {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    }
  }

  async clear(): Promise<void> {
    if (existsSync(this.#path)) {
      const file = lstatSync(this.#path);
      if (!file.isFile() || file.isSymbolicLink())
        throw new Error("Refusing to remove an unsafe authentication path.");
      rmSync(this.#path);
    }
  }
}

class MacKeychainStore implements CredentialStore {
  readonly #account: string;

  constructor(account: string) {
    this.#account = account;
  }

  available(): boolean {
    return (
      process.platform === "darwin" &&
      spawnSync("security", ["help"], { stdio: "ignore" }).status === 0
    );
  }

  async load(): Promise<StoredCredential | null> {
    const result = spawnSync(
      "security",
      [
        "find-generic-password",
        "-a",
        this.#account,
        "-s",
        "com.preprocess.cli",
        "-w",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 },
    );
    if (result.status === 44) return null;
    if (result.status !== 0)
      throw new Error("The OS keychain could not be read.");
    return validateStoredCredential(JSON.parse(result.stdout) as unknown);
  }

  async save(value: StoredCredential): Promise<void> {
    const secret = JSON.stringify(validateStoredCredential(value));
    const result = spawnSync(
      "security",
      [
        "add-generic-password",
        "-U",
        "-a",
        this.#account,
        "-s",
        "com.preprocess.cli",
        "-w",
      ],
      { input: secret, stdio: ["pipe", "ignore", "ignore"] },
    );
    if (result.status !== 0)
      throw new Error("The OS keychain could not store authentication.");
  }

  async clear(): Promise<void> {
    const result = spawnSync(
      "security",
      [
        "delete-generic-password",
        "-a",
        this.#account,
        "-s",
        "com.preprocess.cli",
      ],
      { stdio: "ignore" },
    );
    if (result.status !== 0 && result.status !== 44)
      throw new Error("The OS keychain could not clear authentication.");
  }
}

export class SystemCredentialStore implements CredentialStore {
  readonly #keychain: MacKeychainStore;
  readonly #fallback: FileCredentialStore;

  constructor(homeDirectory: string, account = "default") {
    this.#keychain = new MacKeychainStore(account);
    this.#fallback = new FileCredentialStore(
      join(homeDirectory, ".config", "preprocess", "session.json"),
    );
  }

  async load(): Promise<StoredCredential | null> {
    if (this.#keychain.available()) {
      const credential = await this.#keychain.load();
      if (credential) return credential;
    }
    return this.#fallback.load();
  }

  async save(value: StoredCredential): Promise<void> {
    if (this.#keychain.available()) {
      await this.#keychain.save(value);
      await this.#fallback.clear();
      return;
    }
    await this.#fallback.save(value);
  }

  async clear(): Promise<void> {
    if (this.#keychain.available()) await this.#keychain.clear();
    await this.#fallback.clear();
  }
}

export function assertRestrictedFile(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600)
    throw new Error("Authentication fallback file must use mode 0600.");
}
