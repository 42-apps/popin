import { signIn, signOut, currentUser, getToken, handleRedirect, isConfigured } from "./lib/auth.js";
import { peopleICanVisit, weatherAt, usesFahrenheit } from "./lib/api.js";
import { Signaling } from "./lib/signaling.js";

const $ = (id) => document.getElementById(id);
let sig = null, clockTimer = null;

async function render() {
  const user = currentUser();
  $("signin-view").hidden = !!user;
  $("list-view").hidden = !user;
  $("signout").hidden = !user;
  if (!user) { sig?.close(); sig = null; $("cfg").hidden = isConfigured(); return; }
  $("me").textContent = user.email || user.name || "you";
  await loadPeople();
}

async function loadPeople() {
  try {
    const { people, viewerCountry } = await peopleICanVisit();
    const fahrenheit = usesFahrenheit(viewerCountry);
    const ul = $("people");
    ul.innerHTML = "";
    $("empty").hidden = people.length > 0;
    for (const p of people) {
      const display = p.name || p.email;
      const li = document.createElement("li");
      li.dataset.email = p.email; li._person = p;
      if (p.tz) li.dataset.tz = p.tz;

      const dot = el("span", "dot"); dot.title = "offline";
      const info = el("div", "info");
      const name = el("span", "name"); name.textContent = display;
      const status = el("span", "status"); status.textContent = "Offline";
      const stats = el("span", "stats"); stats.textContent = statsLine(p);
      const meta = el("span", "meta"); meta.textContent = localLine(p);
      info.append(name, status, stats, meta);

      const glance = el("button", "glance"); glance.textContent = "Glance";
      glance.title = "Quietly look in — one-way, they can't see you";
      glance.onclick = () => openCall(p.email, display, true);
      const btn = el("button", "popin"); btn.textContent = "Pop In";
      btn.onclick = () => openCall(p.email, display, false);

      li.append(dot, info, glance, btn);
      ul.appendChild(li);

      if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
        weatherAt(p.lat, p.lon, fahrenheit).then((w) => {
          if (w) { li._weather = w; meta.textContent = localLine(p, w); }
        });
      }
    }
    startClock();
    connectPresence();
  } catch (e) {
    $("status").textContent = "Couldn't load your circle: " + e.message;
  }
}

function statsLine(p) {
  const n = p.pop_ins || 0;
  if (!n) return "No pop-ins yet";
  const unit = n === 1 ? "pop-in" : "pop-ins";
  if (p.last_pop_in) {
    const d = new Date(p.last_pop_in).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
    return `${n} ${unit} · last ${d}`;
  }
  return `${n} ${unit}`;
}

function localLine(p, w = p?._weather) {
  const parts = [];
  const t = localTime(p.tz);
  if (t) parts.push(t);
  if (w && Number.isFinite(w.temp)) parts.push(`${w.temp}${w.unit}`);
  if (p.city) parts.push(p.city);
  let s = parts.join(" · ");
  if (isAsleep(p.tz, w)) s += " 🦉";
  return s;
}
function localTime(tz) {
  if (!tz) return "";
  try { return new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(new Date()); }
  catch { return ""; }
}
function isAsleep(tz, w) {
  const m = localMinutes(tz);
  if (m == null) return false;
  let sunrise = 6 * 60 + 30;
  if (w?.sunrise) { const hm = w.sunrise.split("T")[1]; if (hm) sunrise = (+hm.slice(0, 2)) * 60 + (+hm.slice(3, 5)); }
  return m >= 21 * 60 + 30 || m < sunrise;
}
function localMinutes(tz) {
  if (!tz) return null;
  try {
    const parts = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).formatToParts(new Date());
    return (+parts.find((x) => x.type === "hour").value % 24) * 60 + (+parts.find((x) => x.type === "minute").value);
  } catch { return null; }
}
function startClock() {
  clearInterval(clockTimer);
  clockTimer = setInterval(() => {
    document.querySelectorAll("#people li").forEach((li) => {
      const meta = li.querySelector(".meta");
      if (li._person && meta) meta.textContent = localLine(li._person, li._weather);
    });
  }, 60000);
}

async function connectPresence() {
  const token = getToken();
  if (!token) return;
  sig?.close();
  sig = new Signaling(token);
  sig.on("presence", (online, busyWith) => {
    document.querySelectorAll("#people li").forEach((li) => {
      const email = li.dataset.email;
      const on = online.has(email);
      const busy = busyWith?.[email];
      const dot = li.querySelector(".dot");
      const status = li.querySelector(".status");
      const popin = li.querySelector(".popin");
      const glance = li.querySelector(".glance");
      dot.classList.toggle("online", on);
      dot.classList.toggle("busy", !!busy);
      dot.title = busy ? `on a call with ${busy}` : (on ? "online" : "offline");
      status.textContent = busy ? `On a call with ${busy}` : (on ? "Online" : "Offline");
      status.classList.toggle("busy", !!busy);
      const blocked = !on || !!busy;
      popin.disabled = blocked; popin.textContent = busy ? "Busy" : "Pop In";
      glance.disabled = blocked;
    });
  });
  sig.connect();
}

// Open the call in its own window/tab so the call view can window.close() itself when it ends.
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
function openCall(email, name, glance) {
  const g = glance ? "&glance=1" : "";
  const url = `call.html?to=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}${g}`;
  // Mobile browsers throttle/suspend background tabs, which stalls WebRTC ICE → black screen. Navigate
  // in the SAME tab on phones so the call is always foreground; desktop keeps the pop-out window.
  if (IS_MOBILE) { location.href = url; return; }
  window.open(url, "_blank");
}

function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

$("signin").onclick = () => {
  try { signIn(); } catch (e) { $("cfg").hidden = false; $("status").textContent = e.message; }
};
$("signout").onclick = () => { signOut(); render(); };

// On load: if we just came back from Google, finish sign-in, then render.
(async () => {
  try { await handleRedirect(); } catch (e) { $("status").textContent = "Sign-in failed: " + e.message; }
  render();
})();
