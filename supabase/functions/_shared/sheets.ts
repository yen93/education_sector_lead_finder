// _shared/sheets.ts
// Append rows to a Google Sheet using a service account (GOOGLE_SERVICE_ACCOUNT_JSON,
// the same SA alternate-lead-finder uses). RS256 JWT -> OAuth2 token -> values:append.

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

export function hasSheetsSA(): boolean {
  return (Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") ?? "").length > 0;
}

function b64urlFromString(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function getAccessToken(saJson: string, scope: string): Promise<string> {
  const sa: ServiceAccount = JSON.parse(saJson);
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlFromString(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64urlFromString(JSON.stringify({
    iss: sa.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claim}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  const jwt = `${signingInput}.${b64urlFromBytes(new Uint8Array(sig))}`;
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error(`google token ${resp.status}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.access_token as string;
}

// Append rows to `${tab}` (A:... ) with USER_ENTERED so numbers/links render.
export async function appendRows(
  spreadsheetId: string,
  rangeA1: string,
  rows: (string | number | null)[][],
): Promise<number> {
  const saJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") ?? "";
  if (!saJson) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON");
  if (rows.length === 0) return 0;
  const token = await getAccessToken(saJson, "https://www.googleapis.com/auth/spreadsheets");
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}` +
    `/values/${encodeURIComponent(rangeA1)}:append` +
    `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: rows }),
  });
  if (!resp.ok) {
    throw new Error(`sheets append ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  return rows.length;
}
