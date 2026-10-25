/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi();

const audio = new Audio();
audio.preload = "auto";

const ui = {
  name: document.getElementById("track-name"),
  meta: document.getElementById("track-meta"),
  index: document.getElementById("track-index"),
  play: document.getElementById("play"),
  prev: document.getElementById("prev"),
  next: document.getElementById("next"),
  loop: document.getElementById("loop"),
  rate: document.getElementById("rate"),
  volume: document.getElementById("volume"),
  time: document.getElementById("time"),
  duration: document.getElementById("duration"),
  canvas: document.getElementById("wave"),
  hint: document.getElementById("wave-hint"),
};

const saved = vscode.getState() || {};
let volume = typeof saved.volume === "number" ? saved.volume : 1;
let rate = typeof saved.rate === "number" ? saved.rate : 1;
let looping = saved.loop === true;

let peaks = null;
let columns = 0;
let trackCount = 0;
let trackIndex = 0;
let dragging = false;
let frame = 0;
let objectUrl = null;
let decodeToken = 0;

audio.volume = volume;
audio.playbackRate = rate;
audio.loop = looping;
ui.volume.value = String(volume);
ui.rate.value = String(rate);
ui.loop.classList.toggle("active", looping);

/* ---------- formatting ---------- */

function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    return `${hours}:${String(mins % 60).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function persist() {
  vscode.setState({ volume, rate, loop: looping });
}

/* ---------- waveform ---------- */

function computePeaks(buffer) {
  const data = buffer.getChannelData(0);
  const bucket = Math.max(1, Math.floor(data.length / columns));
  const out = new Float32Array(columns * 2);
  for (let col = 0; col < columns; col += 1) {
    const start = col * bucket;
    const end = Math.min(data.length, start + bucket);
    let min = 0;
    let max = 0;
    for (let i = start; i < end; i += 1) {
      const value = data[i];
      if (value < min) {
        min = value;
      }
      if (value > max) {
        max = value;
      }
    }
    out[col * 2] = min;
    out[col * 2 + 1] = max;
  }
  return out;
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, ui.canvas.clientWidth);
  const height = Math.max(1, ui.canvas.clientHeight);
  ui.canvas.width = Math.floor(width * dpr);
  ui.canvas.height = Math.floor(height * dpr);
  const ctx = ui.canvas.getContext("2d");
  if (ctx) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  columns = Math.max(1, Math.floor(width));
}

function draw(progress) {
  const ctx = ui.canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  const width = ui.canvas.clientWidth;
  const height = ui.canvas.clientHeight;
  ctx.clearRect(0, 0, width, height);

  if (!peaks) {
    return;
  }

  const style = getComputedStyle(document.body);
  const base = style.getPropertyValue("--wave") || "#555";
  const played = style.getPropertyValue("--wave-played") || "#1f9cf0";
  const mid = height / 2;
  const scale = (height / 2) * 0.94;

  const playedCols = Math.floor(width * Math.min(1, Math.max(0, progress)));
  for (let col = 0; col < columns; col += 1) {
    const min = peaks[col * 2];
    const max = peaks[col * 2 + 1];
    const top = mid - max * scale;
    const bottom = mid - min * scale;
    ctx.fillStyle = col <= playedCols ? played : base;
    ctx.fillRect(col, top, 1, Math.max(1, bottom - top));
  }
}

function tick() {
  const duration = audio.duration || 0;
  draw(duration > 0 ? audio.currentTime / duration : 0);
  ui.time.textContent = clock(audio.currentTime);
  frame = requestAnimationFrame(tick);
}

function startTicking() {
  if (!frame) {
    frame = requestAnimationFrame(tick);
  }
}

function stopTicking() {
  if (frame) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
}

/* ---------- transport ---------- */

function post(type, extra) {
  vscode.postMessage(Object.assign({ type }, extra || {}));
}

function toggle() {
  if (audio.paused) {
    audio.play().catch(() => undefined);
  } else {
    audio.pause();
  }
}

function seek(fraction) {
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
    return;
  }
  audio.currentTime = Math.min(audio.duration, Math.max(0, fraction * audio.duration));
}

function stepBay(seconds) {
  audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + seconds));
}

function select(index) {
  if (trackCount === 0) {
    return;
  }
  const wrapped = (index + trackCount) % trackCount;
  if (wrapped !== trackIndex) {
    post("select", { index: wrapped });
  }
}

function nextTrack() {
  select(trackIndex + 1);
}

function prevTrack() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  select(trackIndex - 1);
}

/* ---------- events ---------- */

audio.addEventListener("play", () => {
  ui.play.textContent = "❚❚";
  ui.play.classList.add("active");
  startTicking();
  post("status", { name: ui.name.textContent, playing: true });
});

audio.addEventListener("pause", () => {
  ui.play.textContent = "▶";
  ui.play.classList.remove("active");
  stopTicking();
  draw(audio.duration ? audio.currentTime / audio.duration : 0);
  post("status", { name: ui.name.textContent, playing: false });
});

audio.addEventListener("loadedmetadata", () => {
  ui.duration.textContent = clock(audio.duration);
});

audio.addEventListener("ended", () => {
  if (!audio.loop) {
    nextTrack();
  }
});

ui.play.addEventListener("click", toggle);
ui.next.addEventListener("click", nextTrack);
ui.prev.addEventListener("click", prevTrack);

ui.loop.addEventListener("click", () => {
  looping = !looping;
  audio.loop = looping;
  ui.loop.classList.toggle("active", looping);
  persist();
});

ui.rate.addEventListener("change", () => {
  rate = Number(ui.rate.value) || 1;
  audio.playbackRate = rate;
  persist();
});

ui.volume.addEventListener("input", () => {
  volume = Number(ui.volume.value);
  audio.volume = volume;
  persist();
});

ui.canvas.addEventListener("pointerdown", (event) => {
  dragging = true;
  ui.canvas.setPointerCapture(event.pointerId);
  seek(event.offsetX / ui.canvas.clientWidth);
});

ui.canvas.addEventListener("pointermove", (event) => {
  if (dragging) {
    seek(event.offsetX / ui.canvas.clientWidth);
  }
});

ui.canvas.addEventListener("pointerup", (event) => {
  dragging = false;
  ui.canvas.releasePointerCapture(event.pointerId);
});

window.addEventListener("resize", () => {
  const hadPeaks = peaks;
  resizeCanvas();
  peaks = null;
  if (hadPeaks) {
    /* recompute lazily on next track load */
    ui.hint.hidden = false;
    ui.hint.textContent = "resize — reopen the file to redraw the waveform";
  }
  draw(audio.duration ? audio.currentTime / audio.duration : 0);
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
    return;
  }
  const handled = () => {
    event.preventDefault();
    event.stopPropagation();
  };
  switch (event.key) {
    case " ":
      handled();
      toggle();
      break;
    case "ArrowRight":
      handled();
      stepBay(event.shiftKey ? 1 : 5);
      break;
    case "ArrowLeft":
      handled();
      stepBay(event.shiftKey ? -1 : -5);
      break;
    case "ArrowUp":
      handled();
      volume = Math.min(1, volume + 0.05);
      audio.volume = volume;
      ui.volume.value = String(volume);
      persist();
      break;
    case "ArrowDown":
      handled();
      volume = Math.max(0, volume - 0.05);
      audio.volume = volume;
      ui.volume.value = String(volume);
      persist();
      break;
    case "n":
    case "N":
      handled();
      nextTrack();
      break;
    case "p":
    case "P":
      handled();
      prevTrack();
      break;
    case "l":
    case "L":
      handled();
      ui.loop.click();
      break;
    case "Home":
      handled();
      audio.currentTime = 0;
      break;
    case "End":
      handled();
      audio.currentTime = Math.max(0, (audio.duration || 0) - 0.25);
      break;
  }
});

/* ---------- messages from the extension host ---------- */

async function loadTrack(payload) {
  const bytes = payload.bytes;
  if (!(bytes instanceof Uint8Array)) {
    ui.hint.textContent = "could not read the file";
    return;
  }

  trackIndex = payload.index || 0;
  trackCount = payload.count || 1;
  ui.name.textContent = payload.name || "audio";
  ui.index.textContent = trackCount > 1 ? `${trackIndex + 1} / ${trackCount}` : "";
  document.title = payload.name || "myVSCPlayer";

  audio.pause();
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }

  const blob = new Blob([bytes], { type: "application/octet-stream" });
  objectUrl = URL.createObjectURL(blob);
  audio.src = objectUrl;
  audio.load();

  if (payload.autoplay) {
    audio.play().catch(() => undefined);
  }

  /* waveform */
  peaks = null;
  resizeCanvas();
  ui.hint.hidden = false;
  ui.hint.textContent = "decoding…";
  draw(0);

  const token = ++decodeToken;
  try {
    const copy = bytes.slice();
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const buffer = await context.decodeAudioData(copy.buffer);
    await context.close();
    if (token !== decodeToken) {
      return;
    }
    peaks = computePeaks(buffer);
    ui.meta.textContent = `${(buffer.sampleRate / 1000).toFixed(1)} kHz · ${buffer.numberOfChannels === 1 ? "mono" : "stereo"} · ${clock(buffer.duration)}`;
    ui.hint.hidden = true;
    draw(0);
  } catch (error) {
    if (token === decodeToken) {
      ui.hint.hidden = false;
      ui.hint.textContent = "waveform unavailable (playback still works)";
      ui.meta.textContent = "";
    }
  }

  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: payload.name || "",
        artist: "myVSCPlayer",
      });
      navigator.mediaSession.setActionHandler("play", () => audio.play());
      navigator.mediaSession.setActionHandler("pause", () => audio.pause());
      navigator.mediaSession.setActionHandler("nexttrack", nextTrack);
      navigator.mediaSession.setActionHandler("previoustrack", prevTrack);
    } catch (error) {
      /* mediaSession is best-effort */
    }
  }
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") {
    return;
  }
  if (message.type === "track") {
    loadTrack(message);
  } else if (message.type === "error") {
    ui.hint.hidden = false;
    ui.hint.textContent = message.message || "error";
  }
});

resizeCanvas();
post("ready");
