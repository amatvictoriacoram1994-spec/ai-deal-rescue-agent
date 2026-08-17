import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

const CLIENT_PATH = "credentials/google-oauth-client.json";
const TOKEN_PATH = "credentials/google-calendar-token.json";
const CALENDAR_EVENTS_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

type OAuthClientFile = {
  installed?: {
    client_id?: unknown;
    client_secret?: unknown;
    auth_uri?: unknown;
    token_uri?: unknown;
  };
};

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
  expires_in?: unknown;
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`The OAuth response or client is missing ${field}.`);
  }
  return value.trim();
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "rundll32" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => console.error("Could not open the browser automatically; use the URL shown above."));
    child.unref();
  } catch {
    console.error("Could not open the browser automatically; use the URL shown above.");
  }
}

async function main(): Promise<void> {
  const parsed = JSON.parse(await readFile(resolve(process.cwd(), CLIENT_PATH), "utf8")) as OAuthClientFile;
  if (parsed.installed === undefined) throw new Error("The active RevOps credential is not an installed/desktop OAuth client.");
  const clientId = requiredString(parsed.installed.client_id, "client_id");
  const clientSecret = requiredString(parsed.installed.client_secret, "client_secret");
  const authUri = requiredString(parsed.installed.auth_uri, "auth_uri");
  const tokenUri = requiredString(parsed.installed.token_uri, "token_uri");
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((error: Error) => void) | undefined;
  const codePromise = new Promise<string>((resolvePromise, rejectPromise) => {
    resolveCode = resolvePromise;
    rejectCode = rejectPromise;
  });
  const server = createServer((request, response) => {
    const callback = new URL(request.url ?? "/", "http://127.0.0.1");
    if (callback.pathname !== "/oauth2/callback") {
      response.writeHead(404).end("Not found");
      return;
    }
    if (callback.searchParams.get("state") !== state) {
      response.writeHead(400).end("Authorization failed: invalid state.");
      rejectCode?.(new Error("Google returned an invalid OAuth state."));
      return;
    }
    const oauthError = callback.searchParams.get("error");
    const code = callback.searchParams.get("code");
    if (oauthError !== null || code === null || code.length === 0) {
      response.writeHead(400).end("Authorization was not completed. You may close this tab.");
      rejectCode?.(new Error(oauthError === null ? "Google returned no authorization code." : `Google authorization failed: ${oauthError}.`));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Calendar authorization received. You may close this tab and return to the terminal.");
    resolveCode?.(code);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Unable to determine the loopback callback port.");
  const redirectUri = `http://127.0.0.1:${address.port}/oauth2/callback`;
  const authorizationUrl = new URL(authUri);
  for (const [name, value] of Object.entries({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: CALENDAR_EVENTS_READONLY_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })) authorizationUrl.searchParams.set(name, value);

  console.log(`Authorize Calendar events read-only access in your browser:\n${authorizationUrl.toString()}`);
  openBrowser(authorizationUrl.toString());
  const timeout = setTimeout(() => rejectCode?.(new Error("Timed out waiting for Google authorization.")), CALLBACK_TIMEOUT_MS);
  try {
    const code = await codePromise;
    const response = await fetch(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    if (!response.ok) throw new Error(`Google token exchange failed with HTTP ${response.status} ${response.statusText}.`);
    const token = await response.json() as TokenResponse;
    const accessToken = requiredString(token.access_token, "access_token");
    const refreshToken = requiredString(token.refresh_token, "refresh_token");
    const scope = requiredString(token.scope, "scope");
    const scopes = scope.split(/\s+/).filter(Boolean);
    if (scopes.length !== 1 || scopes[0] !== CALENDAR_EVENTS_READONLY_SCOPE) {
      throw new Error("Google returned scopes other than calendar.events.readonly; no token was saved.");
    }
    if (typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
      throw new Error("Google returned no valid expiry; no token was saved.");
    }
    const output = {
      access_token: accessToken,
      refresh_token: refreshToken,
      scope,
      expiry_date: Date.now() + token.expires_in * 1_000,
    };
    await writeFile(resolve(process.cwd(), TOKEN_PATH), `${JSON.stringify(output, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    console.log(`Success: Calendar events read-only OAuth token saved to ${TOKEN_PATH}.`);
  } finally {
    clearTimeout(timeout);
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

main().catch((error: unknown) => {
  console.error(`Calendar authorization failed: ${error instanceof Error ? error.message : "Unknown error."}`);
  process.exitCode = 1;
});
