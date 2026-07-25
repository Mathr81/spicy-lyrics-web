// Spotify OAuth 2.0 Authorization Code flow with PKCE (no client secret, safe
// for a static site). The resulting access token is used both for the lyrics
// API (Bearer) and for playback control.
import { CLIENT_ID, REDIRECT_URI, SCOPES } from "../config.ts";

const TOKEN_KEY = "SL:web:spotifyToken";
const VERIFIER_KEY = "SL:web:pkceVerifier";

interface StoredToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // epoch ms
}

const AUTH_ENDPOINT = "https://accounts.spotify.com/authorize";
const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";

function randomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256(input: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
}

function readStored(): StoredToken | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as StoredToken) : null;
  } catch {
    return null;
  }
}

function writeStored(token: StoredToken): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
}

export function isLoggedIn(): boolean {
  return readStored() !== null;
}

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** Kick off the login redirect. */
export async function login(): Promise<void> {
  const verifier = randomString(96);
  localStorage.setItem(VERIFIER_KEY, verifier);
  const challenge = base64url(await sha256(verifier));

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  window.location.href = `${AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * If the page loaded on the OAuth redirect (has ?code=...), exchange it for a
 * token and clean the URL. Returns true if a login was completed.
 */
export async function handleRedirectCallback(): Promise<boolean> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) {
    cleanUrl(url);
    throw new Error(`Spotify authorization failed: ${error}`);
  }
  if (!code) return false;

  const verifier = localStorage.getItem(VERIFIER_KEY);
  if (!verifier) {
    cleanUrl(url);
    throw new Error("Missing PKCE verifier (login state lost). Please try again.");
  }

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    cleanUrl(url);
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  storeTokenResponse(json);
  localStorage.removeItem(VERIFIER_KEY);
  cleanUrl(url);
  return true;
}

function cleanUrl(url: URL): void {
  url.searchParams.delete("code");
  url.searchParams.delete("error");
  url.searchParams.delete("state");
  window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
}

function storeTokenResponse(json: any): void {
  const prev = readStored();
  writeStored({
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? prev?.refreshToken ?? null,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  });
}

async function refresh(refreshToken: string): Promise<StoredToken | null> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    logout();
    return null;
  }
  storeTokenResponse(await res.json());
  return readStored();
}

let inflightRefresh: Promise<string | null> | null = null;

/** Return a valid access token, refreshing if it's within 60s of expiry. */
export async function getAccessToken(): Promise<string | null> {
  const stored = readStored();
  if (!stored) return null;
  if (Date.now() < stored.expiresAt - 60_000) return stored.accessToken;
  if (!stored.refreshToken) {
    logout();
    return null;
  }
  if (!inflightRefresh) {
    inflightRefresh = refresh(stored.refreshToken)
      .then((t) => t?.accessToken ?? null)
      .finally(() => {
        inflightRefresh = null;
      });
  }
  return inflightRefresh;
}
