// _shared/apify.ts
// Thin wrapper around Apify's run-sync-get-dataset-items endpoint.
// Pattern lifted verbatim from apify-platforms-sync/index.ts (retry on 429/5xx,
// AbortController hard timeout). Returns the dataset items array.

const APIFY_TOKEN =
  Deno.env.get("APIFY_API_TOKEN") ?? Deno.env.get("APIFY_TOKEN") ?? "";
const APIFY_RUN_TIMEOUT_S = parseInt(
  Deno.env.get("APIFY_RUN_TIMEOUT_S") ?? "95",
  10,
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function hasApifyToken(): boolean {
  return APIFY_TOKEN.length > 0;
}

// Raw diagnostic: returns the HTTP status + a body snippet + first item so we can
// confirm the actor's input shape and output field names.
export async function apifyProbe(
  actorId: string,
  input: unknown,
): Promise<{ status: number; ok: boolean; bodyLen: number; itemsLen: number; firstKeys: string[]; snippet: string }> {
  const path = actorId.replace("/", "~");
  const url =
    `https://api.apify.com/v2/acts/${path}/run-sync-get-dataset-items` +
    `?token=${APIFY_TOKEN}&timeout=${APIFY_RUN_TIMEOUT_S}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const text = await r.text();
  let itemsLen = 0;
  let firstKeys: string[] = [];
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data)) {
      itemsLen = data.length;
      if (data[0] && typeof data[0] === "object") firstKeys = Object.keys(data[0]);
    }
  } catch { /* not json */ }
  return {
    status: r.status,
    ok: r.ok,
    bodyLen: text.length,
    itemsLen,
    firstKeys,
    snippet: text.slice(0, 600),
  };
}

// deno-lint-ignore no-explicit-any
export async function apifyScrape(
  actorId: string,
  input: unknown,
  tries = 0,
  // deno-lint-ignore no-explicit-any
): Promise<any[]> {
  if (!APIFY_TOKEN) throw new Error("Missing APIFY_API_TOKEN");
  const path = actorId.replace("/", "~");
  const url =
    `https://api.apify.com/v2/acts/${path}/run-sync-get-dataset-items` +
    `?token=${APIFY_TOKEN}&timeout=${APIFY_RUN_TIMEOUT_S}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (APIFY_RUN_TIMEOUT_S + 10) * 1000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      if ((r.status === 429 || r.status >= 500) && tries < 2) {
        await sleep(2000);
        return apifyScrape(actorId, input, tries + 1);
      }
      throw new Error(
        `Apify ${actorId} ${r.status}: ${(await r.text()).slice(0, 300)}`,
      );
    }
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } finally {
    clearTimeout(timer);
  }
}
