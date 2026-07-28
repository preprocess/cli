const digestPattern = /^sha256:[a-f0-9]{64}$/;
const typeIdPattern = /^[a-z][a-z0-9]*_[0-9a-hjkmnp-tv-z]{26}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

export function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`The API returned an invalid ${label}.`);
  return value as Record<string, unknown>;
}

export function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  label = "response",
): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key))
      throw new Error(`The API returned an invalid ${label}.`);
  }
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error(`The API returned an incompatible ${label}.`);
}

export function stringValue(
  value: unknown,
  label: string,
  maximum = 4096,
): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum)
    throw new Error(`The API returned an invalid ${label}.`);
  return value;
}

export function optionalString(
  value: unknown,
  label: string,
  maximum = 4096,
): string | undefined {
  return value === undefined ? undefined : stringValue(value, label, maximum);
}

export function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new Error(`The API returned an invalid ${label}.`);
  return value;
}

export function integerValue(
  value: unknown,
  label: string,
  minimum = 0,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new Error(`The API returned an invalid ${label}.`);
  return value as number;
}

export function typeId(value: unknown, prefix: string): string {
  const result = stringValue(value, `${prefix} identifier`, 64);
  if (!typeIdPattern.test(result) || !result.startsWith(`${prefix}_`))
    throw new Error(`The API returned an invalid ${prefix} identifier.`);
  return result;
}

export function identifier(value: unknown, label: string): string {
  const result = stringValue(value, label, 256);
  if (!identifierPattern.test(result))
    throw new Error(`The API returned an invalid ${label}.`);
  return result;
}

export function digest(value: unknown, label: string): string {
  const result = stringValue(value, label, 72);
  if (!digestPattern.test(result))
    throw new Error(`The API returned an invalid ${label}.`);
  return result;
}

export function timestamp(value: unknown, label: string): string {
  const result = stringValue(value, label, 64);
  if (!Number.isFinite(Date.parse(result)))
    throw new Error(`The API returned an invalid ${label}.`);
  return result;
}

export function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

export function httpsUrl(value: unknown, label: string): string {
  const result = stringValue(value, label, 2048);
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    throw new Error(`The API returned an invalid ${label}.`);
  }
  if (parsed.protocol !== "https:")
    throw new Error(`The API returned an invalid ${label}.`);
  return parsed.href;
}

export function environmentValue(
  value: unknown,
): "development" | "production" {
  if (value !== "development" && value !== "production")
    throw new Error("The API returned an invalid environment.");
  return value;
}

export function pageValue(
  value: unknown,
  validateItem: (item: unknown) => unknown,
): Readonly<Record<string, unknown>> {
  const page = record(value, "page");
  exactKeys(page, ["data", "nextCursor", "hasMore"], [], "page");
  if (!Array.isArray(page.data) || page.data.length > 250)
    throw new Error("The API returned an invalid page.");
  const nextCursor =
    page.nextCursor === null
      ? null
      : stringValue(page.nextCursor, "next cursor", 2048);
  return {
    data: page.data.map(validateItem),
    nextCursor,
    hasMore: booleanValue(page.hasMore, "hasMore"),
  };
}
