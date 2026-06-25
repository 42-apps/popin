// REST calls to the PopIn backend (same Worker as the macOS app).
import { BACKEND } from "./config.js";
import { getToken } from "./auth.js";

async function api(path, opts = {}) {
  const token = await getToken();
  const headers = { ...(opts.headers || {}), Authorization: `Bearer ${token}` };
  if (opts.body) headers["content-type"] = "application/json";
  const res = await fetch(BACKEND + path, { ...opts, headers });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

/// People who authorized ME to pop in on them (the Macs I can call into), plus this viewer's country
/// (so we can show weather in their units — °F for the US et al, else °C). Each person carries
/// name/picture, pop-in stats (pop_ins, last_pop_in), and coarse geo (city, lat, lon, tz).
export async function peopleICanVisit() {
  const d = await api("/authorizations");
  return { people: d.grantedBy || [], viewerCountry: d.viewerCountry || null };
}

/// Short-lived ICE/TURN servers for the call.
export async function turnServers() {
  const d = await api("/turn");
  return d.iceServers || [];
}

/// Current weather for a contact's location (Open-Meteo, free, no key) — temp in the viewer's units,
/// plus today's sunrise/sunset for the "asleep" owl. Returns null on any failure (weather is a nicety).
export async function weatherAt(lat, lon, fahrenheit) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const unit = fahrenheit ? "fahrenheit" : "celsius";
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,weather_code&daily=sunrise,sunset&temperature_unit=${unit}&timezone=auto`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const d = await r.json();
    return {
      temp: Math.round(d.current?.temperature_2m),
      code: d.current?.weather_code ?? 0,
      unit: fahrenheit ? "°F" : "°C",
      sunrise: d.daily?.sunrise?.[0] || null,   // ISO local, e.g. "2026-06-20T07:42"
      sunset: d.daily?.sunset?.[0] || null,
    };
  } catch { return null; }
}

/// Countries that use Fahrenheit (matches the macOS app).
export function usesFahrenheit(country) {
  return ["US", "BS", "KY", "LR", "PW", "FM", "MH"].includes((country || "").toUpperCase());
}
