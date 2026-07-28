function abortError(): Error {
  const error = new Error("Operation cancelled.");
  error.name = "AbortError";
  return error;
}

async function cancelBody(response: Response): Promise<void> {
  if (response.body && !response.body.locked) {
    try {
      await response.body.cancel();
    } catch {
      // The size failure remains authoritative if cancellation also fails.
    }
  }
}

function declaredLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null || !/^(?:0|[1-9][0-9]*)$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

export async function readBoundedJsonResponse(
  response: Response,
  maximumBytes: number,
  label: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const length = declaredLength(response);
  if (length !== undefined && length > maximumBytes) {
    await cancelBody(response);
    throw new Error(`${label} was too large.`);
  }
  if (!response.body) throw new Error(`${label} returned an empty body.`);
  if (signal?.aborted) {
    await cancelBody(response);
    throw abortError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const result = await reader.read();
      if (signal?.aborted) throw abortError();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error(`${label} was too large.`);
      }
      chunks.push(result.value);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} returned invalid UTF-8.`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}
