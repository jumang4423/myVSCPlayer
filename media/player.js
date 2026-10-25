/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi();

const audio = new Audio();
audio.preload = "auto";

const ui = {
  title: document.getElementById("title"),
  meta: document.getElementById("meta"),
  queue: document.getElementById("queue"),
  play: document.getElementById("play"),
  prev: document.getElementById("prev"),
  next: document.getElementById("next"),
  loop: document.getElementById("loop"),
  rate: document.getElementById("rate"),
  volume: document.getElementById("volume"),
  elapsed: document.getElementById("elapsed"),
  total: document.getElementById("total"),
  stage: document.getElementById("stage"),
  canvas: document.getElementById("wave"),
  hint: document.getElementById("hint"),
  tip: document.getElementById("tip"),
};

const saved = vscode.getState() || {};
let volume = typeof saved.volume === "number" ? saved.volume : 1;
let rate = typeof saved.rate === "number" ? saved.rate : 1;
let looping = saved.loop === true;

let peaks = null;
let decoded = null;
let columns = 0;
let queueCount = 0;
let queueIndex = 0;
let dragging = false;
let frame = 0;
let decodeToken = 0;

audio.volume = volume;
audio.playbackRate = rate;
audio.loop = looping;

/* Tape-style speed: the pitch moves with the rate instead of being time-stretched. */
audio.preservesPitch = false;
audio.mozPreservesPitch = false;
audio.webkitPreservesPitch = false;

ui.volume.value = String(volume);
ui.rate.value = String(rate);
ui.loop.classList.toggle("active", looping);

/* ---------- helpers ---------- */

function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes >= 60) {
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function persist() {
  vscode.setState({ volume, rate, loop: looping });
}

function setState(state, message) {
  document.body.dataset.state = state;
  if (message) {
    ui.hint.textContent = message;
  }
}

function setPlaying(playing) {
  document.body.dataset.playing = playing ? "true" : "false";
}

/* ---------- waveform ---------- */

const BAR = 2;
const GAP = 1;

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
  columns = Math.max(1, Math.floor(width / (BAR + GAP)));
}

function themeColor(name, fallback) {
  const raw = getComputedStyle(document.body).getPropertyValue(name).trim();
  return raw || fallback;
}

function draw(progress) {
  const ctx = ui.canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  const width = ui.canvas.clientWidth;
  const height = ui.canvas.clientHeight;
  const mid = height / 2;
  ctx.clearRect(0, 0, width, height);

  const base = themeColor("--bar", "#6e7681");
  const played = themeColor("--bar-played", "#3794ff");

  if (!peaks) {
    ctx.fillStyle = base;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(0, Math.round(mid), width, 1);
    ctx.globalAlpha = 1;
    return;
  }

  const scale = (height / 2) * 0.92;
  const playedCols = Math.floor(columns * Math.min(1, Math.max(0, progress)));

  for (let col = 0; col < columns; col += 1) {
    const min = peaks[col * 2];
    const max = peaks[col * 2 + 1];
    const top = mid - max * scale;
    const bottom = mid - min * scale;
    const barHeight = Math.max(2, bottom - top);
    ctx.fillStyle = col <= playedCols ? played : base;
    ctx.fillRect(col * (BAR + GAP), mid - barHeight / 2, BAR, barHeight);
  }
}

function tick() {
  const duration = audio.duration || 0;
  draw(duration > 0 ? audio.currentTime / duration : 0);
  ui.elapsed.textContent = clock(audio.currentTime);
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
  if (!audio.src) {
    return;
  }
  if (audio.paused) {
    audio.play().catch(() => undefined);
  } else {
    audio.pause();
  }
}

function seekTo(fraction) {
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
    return;
  }
  audio.currentTime = Math.min(audio.duration, Math.max(0, fraction * audio.duration));
}

function skip(seconds) {
  audio.currentTime = Math.max(
    0,
    Math.min(audio.duration || 0, audio.currentTime + seconds),
  );
}

function select(index) {
  if (queueCount <= 0) {
    return;
  }
  const wrapped = (index + queueCount) % queueCount;
  if (wrapped !== queueIndex) {
    post("select", { index: wrapped });
  }
}

function nextTrack() {
  select(queueIndex + 1);
}

function prevTrack() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  select(queueIndex - 1);
}

/* ---------- audio events ---------- */

audio.addEventListener("play", () => {
  setPlaying(true);
  startTicking();
  post("status", { name: ui.title.textContent, playing: true });
});

audio.addEventListener("pause", () => {
  setPlaying(false);
  stopTicking();
  draw(audio.duration ? audio.currentTime / audio.duration : 0);
  post("status", { name: ui.title.textContent, playing: false });
});

audio.addEventListener("loadedmetadata", () => {
  ui.total.textContent = clock(audio.duration);
});

audio.addEventListener("ended", () => {
  if (!audio.loop) {
    nextTrack();
  }
});

/* ---------- controls ---------- */

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
  audio.preservesPitch = false;
  audio.mozPreservesPitch = false;
  audio.webkitPreservesPitch = false;
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
  seekTo(event.offsetX / ui.canvas.clientWidth);
});

ui.canvas.addEventListener("pointermove", (event) => {
  const width = ui.canvas.clientWidth;
  if (dragging) {
    seekTo(event.offsetX / width);
  }
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    const fraction = Math.min(1, Math.max(0, event.offsetX / width));
    ui.tip.hidden = false;
    ui.tip.textContent = clock(fraction * audio.duration);
    ui.tip.style.left = `${Math.min(width - 30, Math.max(30, event.offsetX))}px`;
  }
});

ui.canvas.addEventListener("pointerleave", () => {
  ui.tip.hidden = true;
});

ui.canvas.addEventListener("pointerup", (event) => {
  dragging = false;
  ui.canvas.releasePointerCapture(event.pointerId);
});

window.addEventListener("resize", () => {
  resizeCanvas();
  if (decoded) {
    peaks = computePeaks(decoded);
    setState("ready");
  }
  draw(audio.duration ? audio.currentTime / audio.duration : 0);
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
    return;
  }
  switch (event.key) {
    case " ":
      event.preventDefault();
      toggle();
      break;
    case "ArrowRight":
      event.preventDefault();
      skip(event.shiftKey ? 1 : 5);
      break;
    case "ArrowLeft":
      event.preventDefault();
      skip(event.shiftKey ? -1 : -5);
      break;
    case "ArrowUp":
      event.preventDefault();
      volume = Math.min(1, volume + 0.05);
      audio.volume = volume;
      ui.volume.value = String(volume);
      persist();
      break;
    case "ArrowDown":
      event.preventDefault();
      volume = Math.max(0, volume - 0.05);
      audio.volume = volume;
      ui.volume.value = String(volume);
      persist();
      break;
    case "n":
    case "N":
      event.preventDefault();
      nextTrack();
      break;
    case "p":
    case "P":
      event.preventDefault();
      prevTrack();
      break;
    case "l":
    case "L":
      event.preventDefault();
      ui.loop.click();
      break;
    case "Home":
      event.preventDefault();
      audio.currentTime = 0;
      break;
    case "End":
      event.preventDefault();
      audio.currentTime = Math.max(0, (audio.duration || 0) - 0.25);
      break;
  }
});

/* ---------- load ---------- */

function sourceOf(payload) {
  if (typeof payload.url === "string" && payload.url.length > 0) {
    return payload.url;
  }
  if (typeof payload.data === "string" && payload.data.length > 0) {
    return `data:${payload.mime || "audio/mpeg"};base64,${payload.data}`;
  }
  return null;
}

async function loadTrack(payload) {
  const source = sourceOf(payload);
  if (!source) {
    setState("error", "could not read the file");
    return;
  }

  const wasPlaying = !audio.paused;
  queueIndex = payload.index || 0;
  queueCount = payload.count || 1;

  ui.title.textContent = payload.name || "audio";
  ui.queue.hidden = queueCount <= 1;
  ui.queue.textContent = queueCount > 1 ? `${queueIndex + 1} / ${queueCount}` : "";
  document.title = payload.name || "myVSCPlayer";

  audio.pause();
  stopTicking();
  audio.src = source;
  audio.load();
  ui.elapsed.textContent = "0:00";
  ui.total.textContent = "0:00";

  setState("loading", "reading waveform…");
  peaks = null;
  decoded = null;
  resizeCanvas();
  draw(0);

  if (payload.autoplay || wasPlaying) {
    audio.play().catch(() => undefined);
  }

  const token = ++decodeToken;
  try {
    const response = await fetch(source);
    const buffer = await response.arrayBuffer();
    if (token !== decodeToken) {
      return;
    }
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await context.decodeAudioData(buffer);
    await context.close();
    if (token !== decodeToken) {
      return;
    }
    decoded = audioBuffer;
    peaks = computePeaks(audioBuffer);
    ui.meta.textContent = [
      `${(audioBuffer.sampleRate / 1000).toFixed(1)} kHz`,
      audioBuffer.numberOfChannels === 1 ? "mono" : "stereo",
      clock(audioBuffer.duration),
    ].join(" · ");
    setState("ready");
    draw(audio.duration ? audio.currentTime / audio.duration : 0);
  } catch (error) {
    if (token === decodeToken) {
      ui.meta.textContent = "";
      setState("loaded", "playback ready · waveform unavailable");
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
      /* best effort */
    }
  }
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") {
    return;
  }
  if (message.type === "track") {
    void loadTrack(message);
  } else if (message.type === "error") {
    setState("error", message.message || "error");
  }
});

resizeCanvas();
draw(0);
post("ready");
