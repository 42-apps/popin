// Shared configuration for the PopIn web app (Safari/any browser). Same backend as the macOS app.
export const BACKEND = "https://workers.vedicsociety.org";
export const WS_URL = "wss://workers.vedicsociety.org/ws";

// Google OAuth — a "Web application" client (NOT the Chrome-extension one). Create it at
// console.cloud.google.com → Credentials → OAuth client → Web application, and add this app's URL as an
// **Authorized redirect URI**: https://42-apps.github.io/popin/app/  (and any other origin you host at).
// Then paste the client id below. Until set, sign-in shows a friendly "not configured yet" message.
export const GOOGLE_CLIENT_ID = "273164201875-cuuhpj5s87g8dp18fl0nu5fvuf6dakkk.apps.googleusercontent.com";
