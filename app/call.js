// The WebRTC caller. Mirrors the macOS app's caller flow: (getUserMedia →) fetch TURN → offer →
// send over signaling → apply answer → trickle ICE (buffering remote candidates until the answer is
// set, the same fix that cured the LAN black-video on the Mac).
//
// Adds, toward desktop parity: a silent GLANCE mode (receive-only, no camera/mic), auto-reconnect on
// ICE blips, scroll/drag ZOOM into the remote, and a getStats overlay.
import { turnServers } from "./lib/api.js";
import { getToken } from "./lib/auth.js";
import { Signaling } from "./lib/signaling.js";

const params = new URLSearchParams(location.search);
const to = params.get("to");
const name = params.get("name") || to || "Someone";
const glance = params.get("glance") === "1";
// Phones rarely gather usable host/srflx candidates (NAT/cellular) — logs show 0 host, 0 srflx, just a
// lone relay — so on mobile we go TURN-relay-only from the very first attempt instead of burning the
// gathering window on direct paths that won't connect. Desktop keeps "all" (fast P2P) and only forces
// relay on a retry.
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const $ = (id) => document.getElementById(id);
$("peer").textContent = glance ? `Glancing at ${name}` : name;
if (glance) { document.body.classList.add("glance"); $("hangup").textContent = "Done"; }

let pc, sig, localStream, token;
let callId = crypto.randomUUID();
let remoteSet = false, pendingICE = [], retries = 0, watchdog = null, ended = false;
let statsTimer = null, lastBytes = 0, lastStatsAt = 0;

// Keep the screen awake for the whole call — mobile browsers suspend dimmed/background tabs, which
// stalls WebRTC ICE (the Android black-screen). The lock drops when the tab hides, so re-acquire it.
let wakeLock = null;
async function keepAwake() { try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {} }
function releaseWake() { try { wakeLock?.release(); } catch {} wakeLock = null; }
document.addEventListener("visibilitychange", () => {
  if (!ended && document.visibilityState === "visible") keepAwake();
});

// ── ICE diagnostics: which candidate types each side gathers + the live ICE state. The `relay` (TURN)
// count is the key one — 0 relay on a cross-network call means the network is blocking it. Logged to the
// console ([popin] …) and shown on a small line, so "won't connect" can be diagnosed without webrtc-internals.
const diag = { l: { host: 0, srflx: 0, relay: 0, prflx: 0 }, r: { host: 0, srflx: 0, relay: 0, prflx: 0 }, ice: "new", turn: 0 };
function candType(s) { const m = / typ (\w+)/.exec(s || ""); return m ? m[1] : "?"; }
function bump(side, t) { if (diag[side][t] !== undefined) diag[side][t]++; }
function dlog(m) { console.log("[popin]", m); }
function renderDiag(note) {
  const el = $("diag"); if (!el) return;
  el.classList.add("show");
  el.textContent = `relay: ${diag.turn} servers · ICE ${diag.ice} · you ${diag.l.host}h/${diag.l.srflx}s/${diag.l.relay}r · them ${diag.r.host}h/${diag.r.srflx}s/${diag.r.relay}r` + (note ? ` · ${note}` : "");
}
function failMessage() {
  if (!diag.turn) return "Couldn't connect — no relay server (TURN) available. Try again in a moment.";
  if (!diag.l.relay) return "Couldn't connect — your network looks like it's blocking video calls. Try mobile data or another network.";
  if (!diag.r.relay) return "Couldn't connect — the other person's network may be blocking the call.";
  return "Couldn't connect — please try again.";
}

async function start() {
  token = await getToken();
  if (!token || !to) { $("state").textContent = "Please sign in from the PopIn popup first."; return; }
  keepAwake();   // hold the screen on so the call tab isn't suspended mid-connect (mobile)
  if (!glance) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      $("local").srcObject = localStream;
    } catch (e) { $("state").textContent = "Camera/mic blocked: " + e.message; return; }
  }
  sig = makeSignaling(token);   // connects the WS; sends the offer once it's open AND pc is ready
  await connect(IS_MOBILE);     // mobile → relay-only from the first attempt (see IS_MOBILE note)
}

// Build (or rebuild, on retry) the peer connection. The offer is sent by sendOfferNow once both the
// WS is open and pc exists — order-independent thanks to the guard.
async function connect(relayOnly = false) {
  remoteSet = false; pendingICE = [];
  const iceServers = (await turnServers().catch(() => [])).map((s) => ({
    urls: s.urls, username: s.username, credential: s.credential,
  }));
  diag.turn = iceServers.filter((s) => []
    .concat(s.urls || []).some((u) => typeof u === "string" && u.startsWith("turn"))).length;
  dlog(`ICE servers: ${iceServers.length} (relay/TURN sets: ${diag.turn})`);
  if (!diag.turn) console.warn("[popin] No TURN relay returned — a cross-network call may not connect");
  renderDiag();
  // iceCandidatePoolSize pre-gathers candidates (incl. the slower TURN relay) so they're ready at
  // offer time. On a retry, iceTransportPolicy 'relay' forces the TURN-only path — skip the host/srflx
  // pairs that already failed and spend ICE's whole budget on the relay that traverses strict NATs.
  const cfg = { iceServers, iceCandidatePoolSize: 1 };
  if (relayOnly) { cfg.iceTransportPolicy = "relay"; dlog("retry: forcing TURN relay only"); }
  pc = new RTCPeerConnection(cfg);

  if (glance) {                                   // receive-only: see/hear them, send nothing
    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.addTransceiver("video", { direction: "recvonly" });
  } else {
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  }

  pc.ontrack = (e) => {
    $("remote").srcObject = e.streams[0];
    $("state").textContent = "";
    $("overlay").classList.add("connected");
  };
  pc.onicecandidate = (e) => {
    if (!e.candidate) { dlog("local gathering complete"); renderDiag(); return; }
    const t = candType(e.candidate.candidate); bump("l", t); dlog("local candidate: " + t); renderDiag();
    sig.sendICE(to, e.candidate, callId);
  };
  pc.oniceconnectionstatechange = () => { diag.ice = pc.iceConnectionState; dlog("ICE " + diag.ice); renderDiag(); };
  pc.onicegatheringstatechange = () => {
    if (pc.iceGatheringState === "complete" && diag.turn && !diag.l.relay)
      console.warn("[popin] gathering done but no relay candidate — this network may be blocking video calls");
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === "connected") { retries = 0; clearTimeout(watchdog); $("state").textContent = ""; $("diag").classList.remove("show"); startStats(); }
    else if (s === "disconnected") { $("state").textContent = "Reconnecting…"; armWatchdog(); }
    else if (s === "failed") recover();
  };
  await sendOfferNow();
}

function makeSignaling(t) {
  const s = new Signaling(t);
  s.on("answer", async (_from, sdp) => {
    if (ended || !pc) return;
    await pc.setRemoteDescription({ type: sdp.type, sdp: sdp.sdp });
    remoteSet = true;
    for (const c of pendingICE) { try { await pc.addIceCandidate(c); } catch {} }
    pendingICE = [];
  });
  s.on("ice", async (_from, cand) => {
    bump("r", candType(cand.candidate)); renderDiag();
    const c = new RTCIceCandidate({ candidate: cand.candidate, sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex });
    if (remoteSet && pc) { try { await pc.addIceCandidate(c); } catch {} } else pendingICE.push(c);
  });
  s.on("hangup", () => endCall("They ended the call."));
  s.on("serverError", (msg) => { $("state").textContent = msg || "Couldn't connect."; });
  s.on("cameras", renderCameras);
  s.on("activity", renderActivity);
  s.on("nowplaying", renderNowPlaying);
  s.on("noise", renderNoise);
  s.on("open", () => sendOfferNow());
  s.connect();
  return s;
}

async function sendOfferNow() {
  if (ended || !pc || sig?.ws?.readyState !== WebSocket.OPEN) return;   // fires again on WS "open"
  if (pc.signalingState !== "stable") return;                          // an offer is already in flight
  const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
  await pc.setLocalDescription(offer);
  sig.sendOffer(to, offer, callId, glance);
}

// Don't tear down on a transient blip — give ICE ~12s to re-nominate (often via the TURN relay), then
// auto-retry the whole call (fresh callId) once or twice before giving up. Mirrors the macOS recovery.
function armWatchdog() {
  clearTimeout(watchdog);
  // 20s (was 12s) — a slow cross-continent TURN relay can take longer than 12s to allocate + nominate.
  watchdog = setTimeout(() => { if (pc && pc.connectionState !== "connected") recover(); }, 20000);
}

function recover() {
  if (ended) return;
  clearTimeout(watchdog);
  if (retries >= 2) { endCall(failMessage()); return; }
  retries++;
  $("state").textContent = "Reconnecting…";
  try { sig.sendHangup(to, callId); } catch {}
  try { pc.close(); } catch {}
  callId = crypto.randomUUID();   // fresh call so the callee re-answers cleanly
  connect(retries >= 1);          // force the TURN-relay-only path on every retry
}

function startStats() {
  if (statsTimer) return;
  statsTimer = setInterval(async () => {
    if (!pc || pc.connectionState !== "connected") return;
    try {
      const report = await pc.getStats();
      let w = 0, h = 0, fps = 0, bytes = 0, rtt = 0, conn = "";
      report.forEach((st) => {
        if (st.type === "inbound-rtp" && st.kind === "video") {
          w = st.frameWidth || w; h = st.frameHeight || h; fps = Math.round(st.framesPerSecond || 0); bytes = st.bytesReceived || 0;
        } else if (st.type === "candidate-pair" && st.nominated && st.state === "succeeded") {
          rtt = Math.round((st.currentRoundTripTime || 0) * 1000);
        } else if (st.type === "local-candidate" && st.candidateType) {
          conn = st.candidateType === "relay" ? "relay" : (st.candidateType === "host" ? "direct" : "p2p");
        }
      });
      const now = performance.now();
      let kbps = 0;
      if (lastStatsAt) kbps = Math.max(0, Math.round((bytes - lastBytes) * 8 / (now - lastStatsAt)));
      lastBytes = bytes; lastStatsAt = now;
      $("stats").textContent = `${w}×${h} · ${fps}fps · ${kbps} kbps · ${rtt}ms${conn ? " · " + conn : ""}`;
    } catch {}
  }, 1000);
}

function endCall(msg) {
  ended = true;
  clearTimeout(watchdog); clearInterval(statsTimer);
  releaseWake();
  try { recorder?.stop(); } catch {}
  try { sig?.sendHangup(to, callId); } catch {}
  sig?.close();
  localStream?.getTracks().forEach((t) => t.stop());
  try { pc?.close(); } catch {}
  $("state").textContent = msg || "Call ended.";
  $("controls").hidden = true;
  // Pop-out window (desktop) → close it. Same-tab (mobile) → no opener to close, so go back to the list.
  setTimeout(() => { if (window.opener) window.close(); else location.href = "./"; }, 1600);
}

// ── controls ──────────────────────────────────────────────────────────────
$("hangup").onclick = () => endCall(glance ? "Done." : "Call ended.");
$("mic").onclick = () => {
  const t = localStream?.getAudioTracks()[0];
  if (t) { t.enabled = !t.enabled; $("mic").classList.toggle("off", !t.enabled); }
};
$("cam").onclick = () => {
  const t = localStream?.getVideoTracks()[0];
  if (t) { t.enabled = !t.enabled; $("cam").classList.toggle("off", !t.enabled); }
};
$("statsbtn").onclick = () => $("stats").classList.toggle("show");

// ── "watch" panel: music / activity / room, pushed live by the monitored Mac ──
function renderCameras(cams) {
  const box = $("cams");
  if (!cams || cams.length < 2) { box.hidden = true; return; }
  box.hidden = false; box.innerHTML = "";
  cams.forEach((c, i) => {
    const b = document.createElement("button");
    b.textContent = c.name || `Camera ${c.idx}`;
    if (i === 0) b.classList.add("sel");
    b.onclick = () => {
      sig?.sendCamControl(to, c.idx, true, callId);
      box.querySelectorAll("button").forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
    };
    box.appendChild(b);
  });
}
function renderNowPlaying(np) {
  if (!np) return;
  $("np").textContent = np.title
    ? `${np.playing ? "▶" : "⏸"} ${np.title}${np.artist ? " — " + np.artist : ""}` : "Nothing playing";
  if (np.lists && np.lists.length) {
    const sel = $("playlists"), cur = sel.value;
    sel.innerHTML = '<option value="">Playlists…</option>' + np.lists.map((n) => `<option>${escapeHtml(n)}</option>`).join("");
    sel.value = cur;
  }
}
function renderActivity(a) {
  if (!a) return;
  const idle = a.idleSeconds >= 60 ? `idle ${Math.round(a.idleSeconds / 60)}m` : "active now";
  $("activity").textContent = `${a.current || "—"} · ${idle}`;
}
function renderNoise(samples) {
  if (!samples || !samples.length) return;
  const db = samples[samples.length - 1].db;   // relative dBFS (0 = loudest)
  const label = db > -25 ? "loud" : db > -45 ? "moderate" : db > -60 ? "quiet" : "very quiet";
  $("noise").textContent = `${label} (${db} dB)`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

document.querySelectorAll("#panel [data-mc]").forEach((b) => { b.onclick = () => sig?.sendMusicControl(to, b.dataset.mc, callId); });
$("playlists").onchange = (e) => { if (e.target.value) sig?.sendMusicControl(to, "playlist", callId, { playlist: e.target.value }); };

let askedLists = false;
$("panelbtn").onclick = () => {
  const open = $("panel").hidden;
  $("panel").hidden = !open;
  $("panelbtn").classList.toggle("active", open);
  if (open && !askedLists) { askedLists = true; sig?.sendMusicControl(to, "lists", callId); }
};

// Record the remote stream → download a .webm; snapshot a frame → .png.
let recorder = null, recChunks = [];
$("rec").onclick = () => {
  if (recorder) { recorder.stop(); return; }
  const stream = $("remote").srcObject;
  if (!stream) return;
  try { recorder = new MediaRecorder(stream, { mimeType: "video/webm" }); }
  catch { $("state").textContent = "Recording not supported."; return; }
  recChunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => {
    download(new Blob(recChunks, { type: "video/webm" }), `popin-${stamp()}.webm`);
    recorder = null; $("rec").classList.remove("rec-on"); $("rec").textContent = "Record";
  };
  recorder.start();
  $("rec").classList.add("rec-on"); $("rec").textContent = "Stop";
};
$("photo").onclick = () => {
  const v = $("remote");
  if (!v.videoWidth) return;
  const c = document.createElement("canvas");
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  c.toBlob((b) => b && download(b, `popin-${stamp()}.png`), "image/png");
};
function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function stamp() { return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); }

// ── zoom into the remote (scroll to zoom toward the cursor, drag to pan, double-click to reset) ──
let zoom = 1, panX = 0, panY = 0, dragging = false, lastX = 0, lastY = 0;
const remote = $("remote");
function applyZoom() {
  remote.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  remote.style.cursor = zoom > 1 ? (dragging ? "grabbing" : "grab") : "default";
}
remote.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = remote.getBoundingClientRect();
  const cx = e.clientX - rect.left - rect.width / 2 - panX;
  const cy = e.clientY - rect.top - rect.height / 2 - panY;
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const newZoom = Math.min(5, Math.max(1, zoom * factor));
  const ratio = newZoom / zoom;
  panX -= cx * (ratio - 1); panY -= cy * (ratio - 1);
  zoom = newZoom;
  if (zoom === 1) { panX = 0; panY = 0; }
  applyZoom();
}, { passive: false });
remote.addEventListener("mousedown", (e) => { if (zoom > 1) { dragging = true; lastX = e.clientX; lastY = e.clientY; applyZoom(); } });
window.addEventListener("mousemove", (e) => { if (dragging) { panX += e.clientX - lastX; panY += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; applyZoom(); } });
window.addEventListener("mouseup", () => { dragging = false; applyZoom(); });
remote.addEventListener("dblclick", () => { zoom = 1; panX = 0; panY = 0; applyZoom(); });

window.addEventListener("beforeunload", () => { try { sig?.sendHangup(to, callId); } catch {} });

start();
