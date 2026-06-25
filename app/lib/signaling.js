// WebSocket signaling to the PopIn hub. CALLER-ONLY: this client can place pop-ins (offer/ice/hangup)
// and read presence, but it deliberately ignores incoming offers — it can never be a receiver.
import { WS_URL } from "./config.js";

export class Signaling {
  constructor(token) {
    this.token = token;
    this.ws = null;
    this.handlers = {};
    this.online = new Set();
    this.busyWith = {};   // email → name of who they're on a call with (presence)
  }
  on(event, fn) { this.handlers[event] = fn; return this; }

  connect() {
    this.ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(this.token)}`);
    this.ws.onopen = () => { this.send({ t: "subscribe" }); this.handlers.open?.(); };
    this.ws.onmessage = (e) => { try { this.handle(JSON.parse(e.data)); } catch {} };
    this.ws.onclose = () => this.handlers.close?.();
    this.ws.onerror = () => this.handlers.error?.();
  }

  handle(m) {
    switch (m.t) {
      case "ready": this.handlers.ready?.(); break;
      case "presence-snapshot":
        this.online = new Set((m.users || []).filter((u) => u.online).map((u) => u.user));
        this.busyWith = {};
        for (const u of m.users || []) if (u.busyWith) this.busyWith[u.user] = u.busyWith;
        this.emitPresence(); break;
      case "presence":
        if (m.user) {
          m.online ? this.online.add(m.user) : this.online.delete(m.user);
          if (m.online && m.busyWith) this.busyWith[m.user] = m.busyWith; else delete this.busyWith[m.user];
          this.emitPresence();
        }
        break;
      case "answer":  this.handlers.answer?.(m.from, m.sdp, m.call); break;
      case "ice":     this.handlers.ice?.(m.from, m.candidate, m.call); break;
      case "hangup":  this.handlers.hangup?.(m.from, m.call); break;
      case "error":   this.handlers.serverError?.(m.msg, m.call); break;
      // "Watch" features — the monitored Mac pushes these during a call; we display them.
      case "cameras":    this.handlers.cameras?.(m.cams || []); break;
      case "activity":   this.handlers.activity?.(m.act); break;
      case "nowplaying": this.handlers.nowplaying?.(m.np); break;
      case "noise":      this.handlers.noise?.(m.noise || []); break;
      // "incoming"/"offer" intentionally ignored — caller-only client.
    }
  }

  emitPresence() { this.handlers.presence?.(this.online, this.busyWith); }

  send(obj) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }
  // `glance` = a silent one-way peek: the backend skips the "incoming" banner + doesn't count it.
  sendOffer(to, sdp, call, glance = false) {
    this.send({ t: "offer", to, call, glance, sdp: { type: sdp.type, sdp: sdp.sdp } });
  }
  sendICE(to, cand, call) {
    const c = { candidate: cand.candidate };
    if (cand.sdpMid != null) c.sdpMid = cand.sdpMid;
    if (cand.sdpMLineIndex != null) c.sdpMLineIndex = cand.sdpMLineIndex;
    this.send({ t: "ice", to, call, candidate: c });
  }
  sendHangup(to, call) { this.send({ t: "hangup", to, call }); }
  // Ask the monitored Mac to switch which of its cameras it's sending.
  sendCamControl(to, idx, on, call) { this.send({ t: "camctl", to, call, idx, on }); }
  // Drive the monitored Mac's Music app: cmd = play/pause/playpause/next/prev/vol/playlist/search/lists.
  sendMusicControl(to, cmd, call, { playlist, vol } = {}) {
    const o = { t: "musicctl", to, call, mc: cmd };
    if (playlist != null) o.pl = playlist;
    if (vol != null) o.vol = vol;
    this.send(o);
  }
  close() { try { this.ws?.close(); } catch {} this.ws = null; }
}
