// Google sign-in for the WEB app (Safari/any browser) — a full-page OAuth redirect (response_type=
// id_token) → POST /auth → session stored in localStorage. Same interface as the Chrome client's
// auth (signIn / signOut / currentUser / getToken) so the shared call + api code works unchanged.
import { BACKEND, GOOGLE_CLIENT_ID } from "./config.js";

const KEY = "popin-session";
const configured = () => GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.startsWith("PASTE_");

function redirectURI() { return location.href.split("#")[0].split("?")[0]; }   // this page, sans hash/query

export function signIn() {
  if (!configured()) {
    throw new Error("Sign-in isn't configured yet — add a Web OAuth client id in lib/config.js.");
  }
  const nonce = crypto.randomUUID();
  sessionStorage.setItem("popin-nonce", nonce);
  const url = "https://accounts.google.com/o/oauth2/v2/auth"
    + `?client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}`
    + "&response_type=id_token"
    + `&scope=${encodeURIComponent("openid email profile")}`
    + `&redirect_uri=${encodeURIComponent(redirectURI())}`
    + `&nonce=${nonce}`
    + "&prompt=select_account";
  location.href = url;   // Google bounces back to this page with #id_token=…
}

// Call once on load: if we just came back from Google, exchange the id_token for a session.
export async function handleRedirect() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const idToken = hash.get("id_token");
  if (!idToken) return null;
  history.replaceState(null, "", redirectURI());   // wipe the token from the URL bar
  const res = await fetch(`${BACKEND}/auth`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken }),
  });
  if (!res.ok) throw new Error(`/auth ${res.status}`);
  const { token, user } = await res.json();
  localStorage.setItem(KEY, JSON.stringify({ token, user }));
  return { token, user };
}

function session() { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } }
export function currentUser() { return session().user || null; }
export function getToken() { return session().token || null; }
export function signOut() { localStorage.removeItem(KEY); }
export function isConfigured() { return configured(); }
