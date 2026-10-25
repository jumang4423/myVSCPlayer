/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi();

const audio = new Audio();
audio.preload = "auto";

const ui = {
  title: document.getElementById("title"),
  artist: document.getElementById("artist"),
  play: document.getElementById("play"),
  prev: document.getElementById("prev"),
  next: document.getElementById("next"),
  loop: document.getElementById("loop"),
  sep: document.getElementById("sep"),
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
let waveGain = 1;
let segments = [];
let streamDur = 0;
let coverage = 0;
let columns = 0;
let queueCount = 0;
let queueIndex = 0;
let currentName = "myVSCPlayer";
let dragging = false;
let selecting = false;
let separating = false;
let selA = null;
let selB = null;
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

/* "01 - Artist - Title.mp3" becomes title/artist like a SoundCloud row. */
function describe(name, album) {
  const base = String(name || "").replace(/\.[^.]+$/, "");
  const cleaned = base.replace(/^[0-9]{1,3}[\s._-]+/, "").trim();
  const parts = cleaned.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    return { title: parts.slice(1).join(" - ").trim(), artist: parts[0].trim() };
  }
  return { title: cleaned || "myVSCPlayer", artist: album || "" };
}

function setState(state, message) {  document.body.dataset.state = state;
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
const WAVE_BINS = 2048;

/* Bins are kept per decoded slice, at a fixed resolution, so the waveform can be
   drawn while the rest of the file is still decoding. */
function addSegment(buffer, bins = WAVE_BINS) {
  const data = buffer.getChannelData(0);
  const min = new Float32Array(bins);
  const max = new Float32Array(bins);
  const bucket = Math.max(1, Math.floor(data.length / bins));
  const stride = Math.max(1, Math.floor(bucket / 48));
  for (let b = 0; b < bins; b += 1) {
    const start = b * bucket;
    const end = Math.min(data.length, start + bucket);
    let lo = 0;
    let hi = 0;
    for (let i = start; i < end; i += stride) {
      const value = data[i];
      if (value < lo) {
        lo = value;
      }
      if (value > hi) {
        hi = value;
      }
    }
    min[b] = lo;
    max[b] = hi;
  }
  segments.push({ start: streamDur, dur: buffer.duration, min, max });
  streamDur += buffer.duration;
}

function rebuildPeaks() {
  const total = audio.duration > 0 ? audio.duration : streamDur;
  if (!(total > 0) || segments.length === 0) {
    return;
  }
  const out = new Float32Array(columns * 2);
  for (let col = 0; col < columns; col += 1) {
    const t0 = (col / columns) * total;
    const t1 = ((col + 1) / columns) * total;
    let lo = 0;
    let hi = 0;
    let hit = false;
    for (const seg of segments) {
      if (seg.start + seg.dur <= t0 || seg.start >= t1) {
        continue;
      }
      const bins = seg.min.length;
      const b0 = Math.max(0, Math.floor(((t0 - seg.start) / seg.dur) * bins));
      const b1 = Math.min(bins, Math.ceil(((t1 - seg.start) / seg.dur) * bins));
      for (let b = b0; b < b1; b += 1) {
        if (seg.min[b] < lo) {
          lo = seg.min[b];
        }
        if (seg.max[b] > hi) {
          hi = seg.max[b];
        }
      }
      hit = true;
    }
    if (hit) {
      out[col * 2] = lo;
      out[col * 2 + 1] = hi;
    }
  }
  peaks = out;
  updateGain();
}

/* Normalise the drawing to the track's own peak (99.5th percentile, so one stray
   click does not flatten everything), like SoundCloud does. */
function updateGain() {
  if (!peaks) {
    waveGain = 1;
    return;
  }
  const amplitudes = [];
  for (let i = 0; i < peaks.length; i += 2) {
    amplitudes.push((peaks[i + 1] - peaks[i]) / 2);
  }
  if (amplitudes.length === 0) {
    waveGain = 1;
    return;
  }
  amplitudes.sort((a, b) => a - b);
  const reference =
    amplitudes[Math.min(amplitudes.length - 1, Math.floor(amplitudes.length * 0.98))] || 0;
  waveGain = reference > 0.01 ? Math.min(1 / reference, 25) : 1;
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
  ctx.clearRect(0, 0, width, height);

  const base = themeColor("--bar", "#6e7681");
  const played = themeColor("--bar-played", "#3794ff");

  if (!peaks) {
    ctx.fillStyle = base;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(0, height - 1, width, 1);
    ctx.globalAlpha = 1;
    drawSelection(ctx, width, height);
    return;
  }

  /* SoundCloud style: the baseline is the bottom edge and bars grow upward. */
  const scale = height * 0.94;
  const playedCols = Math.floor(columns * Math.min(1, Math.max(0, progress)));
  const ready = Math.max(1, Math.ceil(columns * Math.min(1, coverage)));

  for (let col = 0; col < ready; col += 1) {
    const min = peaks[col * 2];
    const max = peaks[col * 2 + 1];
    const amplitude = Math.min(1, ((max - min) / 2) * waveGain) ** 0.78;
    const barHeight = Math.max(2, amplitude * scale);
    const y = height - barHeight;
    const x = col * (BAR + GAP);
    ctx.fillStyle = col <= playedCols ? played : base;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, BAR, barHeight, BAR / 2);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, BAR, barHeight);
    }
  }

  drawSelection(ctx, width, height);

  if (progress > 0 && progress < 1) {
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = played;
    ctx.fillRect(Math.round(width * progress), 0, 1, height);
    ctx.restore();
  }
}

function drawSelection(ctx, width, height) {
  const duration = audio.duration || 0;
  if (selA === null || selB === null || duration <= 0) {
    return;
  }
  const from = Math.min(selA, selB) / duration;
  const to = Math.max(selA, selB) / duration;
  const x1 = Math.max(0, Math.min(width, from * width));
  const x2 = Math.max(0, Math.min(width, to * width));
  const accent = themeColor("--bar-played", "#3794ff");

  ctx.save();
  ctx.globalAlpha = 0.2;
  ctx.fillStyle = accent;
  ctx.fillRect(x1, 0, Math.max(1, x2 - x1), height);
  ctx.globalAlpha = 0.95;
  ctx.fillRect(x1 - 1, 0, 2, height);
  ctx.fillRect(x2 - 1, 0, 2, height);
  ctx.restore();
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

function stopSelecting() {
  selecting = false;
  document.body.classList.remove("selecting");
}

function startSeparation(from, to) {
  if (separating) {
    return;
  }
  separating = true;
  ui.sep.classList.add("busy");
  ui.sep.textContent = "…";
  setState("select", `separating ${clock(from)}–${clock(to)}…`);
  post("separate", { start: from, end: to });
}

/* ---------- audio events ---------- */

audio.addEventListener("play", () => {
  setPlaying(true);
  startTicking();
  post("status", { name: currentName, playing: true });});

audio.addEventListener("pause", () => {
  setPlaying(false);
  stopTicking();
  draw(audio.duration ? audio.currentTime / audio.duration : 0);
  post("status", { name: currentName, playing: false });
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

ui.sep.addEventListener("click", () => {
  if (separating) {
    return;
  }
  if (selecting) {
    stopSelecting();
    setState(peaks ? "ready" : "loading");
    return;
  }
  if (!(audio.duration > 0)) {
    return;
  }
  selecting = true;
  document.body.classList.add("selecting");
  setState("select", "drag across the waveform to choose the range");
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
  const width = ui.canvas.clientWidth;
  const fraction = Math.min(1, Math.max(0, event.offsetX / width));
  ui.canvas.setPointerCapture(event.pointerId);
  if (selecting) {
    const duration = audio.duration || 0;
    if (duration <= 0) {
      return;
    }
    dragging = "select";
    selA = fraction * duration;
    selB = selA;
    draw(audio.currentTime / duration);
    return;
  }
  dragging = "seek";
  seekTo(fraction);
});

ui.canvas.addEventListener("pointermove", (event) => {
  const width = ui.canvas.clientWidth;
  const fraction = Math.min(1, Math.max(0, event.offsetX / width));

  if (dragging === "select") {
    const duration = audio.duration || 0;
    selB = fraction * duration;
    draw(duration > 0 ? audio.currentTime / duration : 0);
  } else if (dragging === "seek") {
    seekTo(fraction);
  }

  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    ui.tip.hidden = false;
    ui.tip.textContent = clock(fraction * audio.duration);
    ui.tip.style.left = `${Math.min(width - 30, Math.max(30, event.offsetX))}px`;
  }
});

ui.canvas.addEventListener("pointerleave", () => {
  ui.tip.hidden = true;
});

ui.canvas.addEventListener("pointerup", (event) => {
  ui.canvas.releasePointerCapture(event.pointerId);
  if (dragging === "select") {
    dragging = null;
    const from = Math.min(selA, selB);
    const to = Math.max(selA, selB);
    if (to - from >= 0.5) {
      stopSelecting();
      startSeparation(from, to);
    } else {
      setState("select", "drag a longer range (at least 0.5s)");
    }
    return;
  }
  dragging = null;
});

window.addEventListener("resize", () => {
  resizeCanvas();
  if (segments.length > 0) {
    rebuildPeaks();
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
    case "Escape":
      stopSelecting();
      selA = null;
      selB = null;
      setState(peaks ? "ready" : "loading");
      draw(audio.duration ? audio.currentTime / audio.duration : 0);
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

function whenMetadata() {
  return new Promise((resolve) => {
    if (audio.readyState >= 1 && audio.duration > 0) {
      resolve();
      return;
    }
    const done = () => {
      audio.removeEventListener("loadedmetadata", done);
      resolve();
    };
    audio.addEventListener("loadedmetadata", done);
    setTimeout(done, 3000);
  });
}

/* Waveform: decode the file in slices and draw each one as it lands, so the first
   pixels appear in tens of milliseconds instead of after the whole file decodes. */
async function buildWaveform(source, token) {
  const context = new (window.AudioContext || window.webkitAudioContext)();
  const streamable = /\.(mp3|wav)$/i.test(currentName);

  try {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    if (!response.body || !streamable) {
      const whole = await response.arrayBuffer();
      const buffer = await context.decodeAudioData(whole);
      if (token !== decodeToken) {
        return;
      }
      segments = [];
      streamDur = 0;
      addSegment(buffer, 8192);
      coverage = 1;
      rebuildPeaks();
      setState("ready");
      draw(audio.duration ? audio.currentTime / audio.duration : 0);
      return;
    }

    await whenMetadata();
    const reader = response.body.getReader();
    const SLICE = 512 * 1024;
    let parts = [];
    let size = 0;

    for (;;) {
      const chunk = await reader.read();
      if (token !== decodeToken) {
        await reader.cancel().catch(() => undefined);
        return;
      }
      if (chunk.value) {
        parts.push(chunk.value);
        size += chunk.value.byteLength;
      }
      if (size >= SLICE || (chunk.done && size > 0)) {
        const merged = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          merged.set(part, offset);
          offset += part.byteLength;
        }
        parts = [];
        size = 0;

        try {
          const slice = await context.decodeAudioData(merged.buffer);
          if (token !== decodeToken) {
            return;
          }
          addSegment(slice);
          const total = audio.duration > 0 ? audio.duration : streamDur;
          coverage = total > 0 ? Math.min(1, streamDur / total) : 0;
          rebuildPeaks();
          setState("ready");
          draw(audio.duration ? audio.currentTime / audio.duration : 0);
        } catch (error) {
          /* a slice can straddle a bad frame; keep going */
        }
      }
      if (chunk.done) {
        break;
      }
    }
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function loadTrack(payload) {  const source = sourceOf(payload);
  if (!source) {
    setState("error", "could not read the file");
    return;
  }

  const wasPlaying = !audio.paused;
  queueIndex = payload.index || 0;
  queueCount = payload.count || 1;
  currentName = payload.name || "myVSCPlayer";
  const described = describe(payload.name, payload.album);
  ui.title.textContent = described.title;
  ui.artist.textContent = described.artist;
  document.title = described.title;
  selA = null;
  selB = null;
  stopSelecting();

  audio.pause();
  stopTicking();
  audio.src = source;
  audio.load();
  ui.elapsed.textContent = "0:00";
  ui.total.textContent = "0:00";

  setState("loading", "reading waveform…");
  peaks = null;
  segments = [];
  streamDur = 0;
  coverage = 0;
  resizeCanvas();
  draw(0);

  if (payload.autoplay || wasPlaying) {
    audio.play().catch(() => undefined);
  }

  const token = ++decodeToken;
  try {
    await buildWaveform(source, token);
  } catch (error) {
    if (token === decodeToken) {
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
  } else if (message.type === "sep-state") {
    if (message.phase === "running") {
      ui.sep.classList.add("busy");
      ui.sep.textContent = "…";
      setState("select", message.message || "separating…");
    } else {
      separating = false;
      ui.sep.classList.remove("busy");
      ui.sep.textContent = "SEP";
      setState(message.phase === "error" ? "error" : "message", message.message || "");
    }
  } else if (message.type === "error") {
    setState("error", message.message || "error");
  }
});

resizeCanvas();
draw(0);
post("ready");
