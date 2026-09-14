// Trigger a browser download from an in-memory Blob (used for CSV/Excel exports
// returned by the API as a blob response).
export function downloadBlob(data: Blob, filename: string): void {
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * The filename the SERVER chose, out of the Content-Disposition header.
 *
 * Worth reading rather than guessing when the server knows something the client
 * does not — the business report names itself `Agastya-Report-Jul-2026` for a
 * whole calendar month and spells out both ends of a range otherwise, and the
 * browser has no way to work out which of those applies.
 *
 * Returns undefined when the header is absent or unparseable, so the caller can
 * fall back to a name of its own.
 */
export function filenameFromResponse(
  res: { headers?: Record<string, unknown> },
): string | undefined {
  const raw = res.headers?.["content-disposition"];
  if (typeof raw !== "string") return undefined;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(raw);
  const name = match?.[1]?.trim();
  if (!name) return undefined;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/**
 * Read a Blob as text.
 *
 * `Blob.prototype.text()` is NOT everywhere — Safari only got it in 14, and
 * jsdom still has no implementation — so a bare `await blob.text()` throws
 * "is not a function" on exactly the browsers where an error message matters
 * most. FileReader has worked since forever and is the fallback.
 */
function readBlob(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/**
 * The error message from a request made with `responseType: "blob"`.
 *
 * Axios hands back the error BODY as a Blob too, so the usual `apiError` looks
 * for `response.data.detail` on a Blob, finds nothing, and every failed
 * download reports the same generic "Request failed (413)". The server's actual
 * sentence — "This period holds 40,000 policies … choose a shorter period" — is
 * the only thing that tells the user what to do next, so it is worth the await.
 */
export async function blobError(err: unknown, fallback?: string): Promise<string> {
  const { apiError } = await import("../api/client");
  const body = (err as { response?: { data?: unknown } })?.response?.data;
  if (body instanceof Blob) {
    try {
      const parsed = JSON.parse(await readBlob(body));
      if (typeof parsed?.detail === "string" && parsed.detail.trim())
        return parsed.detail;
    } catch {
      /* not JSON, or unreadable — fall through to the generic message */
    }
  }
  return apiError(err, fallback);
}
