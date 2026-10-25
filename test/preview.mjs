/*
 * Renders the real webview (media/player.html + player.js + player.css) in a plain
 * browser so the layout and waveform can be checked without launching VS Code.
 *
 *   node test/preview.mjs <path-to-audio-file> <output-dir>
 *
 * The generated page stubs acquireVsCodeApi and posts one "track" message.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const audioPath = process.argv[2];
const outDir = process.argv[3];

if (!audioPath || !outDir) {
  console.error("usage: node test/preview.mjs <audio-file> <output-dir>");
  process.exit(1);
}

const mediaDir = resolve(import.meta.dirname, "..", "media");
mkdirSync(outDir, { recursive: true });

const ext = (audioPath.match(/\.[^.\\/]+$/) || [".mp3"])[0].toLowerCase();
const MIME = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".aac": "audio/aac",
};
const servedName = `audio${ext}`;

copyFileSync(join(mediaDir, "player.js"), join(outDir, "player.js"));
copyFileSync(join(mediaDir, "player.css"), join(outDir, "player.css"));
copyFileSync(resolve(audioPath), join(outDir, servedName));

const name = basename(audioPath);
const stub = `<script>
  window.consoleMessages = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (message) => window.consoleMessages.push(message),
    getState: () => undefined,
    setState: () => undefined,
  });
  window.addEventListener("load", () => {
    setTimeout(() => {
      window.postMessage(
        {
          type: "track",
          index: 1,
          count: 6,
          name: ${JSON.stringify(name)},
          mime: ${JSON.stringify(MIME[ext] || "audio/mpeg")},
          autoplay: false,
          url: ${JSON.stringify(servedName)},
        },
        "*",
      );
    }, 60);
  });
</script>`;

const csp =
  "default-src 'none'; style-src 'self'; script-src 'self' 'unsafe-inline'; media-src 'self' blob: data:; connect-src 'self'; img-src 'self' data:";

const html = readFileSync(join(mediaDir, "player.html"), "utf8")
  .replace(
    /<script nonce="\{\{NONCE\}\}" src="\{\{SCRIPT\}\}"><\/script>/,
    `${stub}\n  <script src="player.js"></script>`,
  )
  .replace("{{CSP}}", csp)
  .replace("{{NONCE}}", "preview")
  .replace("{{STYLE}}", "player.css");

writeFileSync(join(outDir, "index.html"), html);
console.log(join(outDir, "index.html"));
