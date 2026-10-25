/*
 * Renders the real webview (media/player.html + player.js + player.css) in a plain
 * browser so the layout and waveform can be checked without launching VS Code.
 *
 *   node test/preview.mjs <path-to-audio-file> <output-dir>
 *
 * The generated page stubs acquireVsCodeApi and posts one "track" message.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const audioPath = process.argv[2];
const outDir = process.argv[3];
const theme = process.argv[4] === "light" ? "light" : "dark";

if (!audioPath || !outDir) {
  console.error("usage: node test/preview.mjs <audio-file> <output-dir> [dark|light]");
  process.exit(1);
}

const THEMES = {
  dark: {
    "--vscode-editor-background": "#1f1f1f",
    "--vscode-foreground": "#cccccc",
    "--vscode-editorWidget-background": "#252526",
    "--vscode-descriptionForeground": "#9d9d9d",
    "--vscode-editorLineNumber-foreground": "#5f5f5f",
    "--vscode-editorHoverWidget-background": "#202020",
    "--vscode-editorHoverWidget-foreground": "#f0f0f0",
    "--vscode-errorForeground": "#f48771",
    "--vscode-font-family": "-apple-system, BlinkMacSystemFont, sans-serif",
    "--vscode-font-size": "13px",
  },
  light: {
    "--vscode-editor-background": "#ffffff",
    "--vscode-foreground": "#3b3b3b",
    "--vscode-editorWidget-background": "#f7f7f8",
    "--vscode-descriptionForeground": "#767676",
    "--vscode-editorLineNumber-foreground": "#c4c4c4",
    "--vscode-editorHoverWidget-background": "#f3f3f3",
    "--vscode-editorHoverWidget-foreground": "#333333",
    "--vscode-errorForeground": "#d93025",
    "--vscode-font-family": "-apple-system, BlinkMacSystemFont, sans-serif",
    "--vscode-font-size": "13px",
  },
};

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
      window.__loadStart = performance.now();
      window.postMessage(
        {
          type: "track",
          index: 1,
          count: 6,
          name: ${JSON.stringify(name)},
          album: ${JSON.stringify(basename(dirname(resolve(audioPath))))},
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
  "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; media-src 'self' blob: data:; connect-src 'self'; img-src 'self' data:";

const html = readFileSync(join(mediaDir, "player.html"), "utf8")
  .replace(
    /<script nonce="\{\{NONCE\}\}" src="\{\{SCRIPT\}\}"><\/script>/,
    `${stub}\n  <script src="player.js"></script>`,
  )
  .replace("{{CSP}}", csp)
  .replace("{{NONCE}}", "preview")
  .replace("{{STYLE}}", "player.css")
  .replace(
    "</head>",
    `<style>:root{${Object.entries(THEMES[theme])
      .map(([key, value]) => `${key}:${value}`)
      .join(";")}}</style>\n</head>`,
  );

writeFileSync(join(outDir, "index.html"), html);
console.log(join(outDir, "index.html"));
