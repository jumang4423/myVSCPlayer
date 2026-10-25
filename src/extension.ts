import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".flac",
  ".m4a",
  ".m4b",
  ".aac",
  ".ogg",
  ".oga",
  ".opus",
  ".aiff",
  ".aif",
  ".weba",
]);

const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".m4b": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".aiff": "audio/aiff",
  ".aif": "audio/aiff",
  ".weba": "audio/webm",
};

const VIEW_TYPE = "myVSCPlayer.audio";

interface TrackEntry {
  uri: vscode.Uri;
  name: string;
}

interface AudioDocument extends vscode.CustomDocument {
  readonly uri: vscode.Uri;
}

let statusBar: vscode.StatusBarItem | undefined;
let activeSession: AudioSession | undefined;
let log: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel("myVSCPlayer");
  context.subscriptions.push(log);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.name = "myVSCPlayer";
  statusBar.text = "$(music) myVSCPlayer";
  statusBar.tooltip = "myVSCPlayer — click to reveal the player";
  statusBar.command = `${VIEW_TYPE}.focus`;
  statusBar.hide();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand(`${VIEW_TYPE}.focus`, () => activeSession?.reveal()),
    vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      new AudioPlayerProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    ),
  );
}

export function deactivate(): void {
  activeSession = undefined;
  statusBar = undefined;
}

class AudioPlayerProvider implements vscode.CustomReadonlyEditorProvider<AudioDocument> {
  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): AudioDocument {
    return {
      uri,
      dispose() {
        /* nothing to release */
      },
    };
  }

  async resolveCustomEditor(document: AudioDocument, panel: vscode.WebviewPanel): Promise<void> {
    const session = new AudioSession(document.uri, panel, this.context);
    activeSession = session;
    panel.onDidDispose(() => {
      if (activeSession === session) {
        activeSession = undefined;
        statusBar?.hide();
      }
    });
    await session.start();
  }
}

class AudioSession {
  private tracks: TrackEntry[] = [];
  private index = 0;
  private separating = false;

  constructor(
    private readonly sourceUri: vscode.Uri,
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
  ) {}

  reveal(): void {
    this.panel.reveal(undefined, true);
  }

  async start(): Promise<void> {
    const webview = this.panel.webview;
    const folder = this.sourceUri.with({ path: path.posix.dirname(this.sourceUri.path) });

    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
        ...(this.sourceUri.scheme === "file" ? [folder] : []),
      ],
    };

    webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== "object") {
        return;
      }
      const msg = message as {
        type?: string;
        index?: number;
        name?: string;
        playing?: boolean;
        start?: number;
        end?: number;
      };
      switch (msg.type) {
        case "ready":
          await this.loadInitial();
          break;
        case "select":
          if (typeof msg.index === "number") {
            await this.select(msg.index);
          }
          break;
        case "status":
          this.applyStatus(msg.name, msg.playing === true);
          break;
        case "separate":
          if (typeof msg.start === "number" && typeof msg.end === "number") {
            void this.separate(msg.start, msg.end);
          }
          break;
      }
    });

    webview.html = await this.html(webview);
    this.panel.title = path.basename(this.sourceUri.fsPath);
  }

  private async html(webview: vscode.Webview): Promise<string> {
    const nonce = Array.from({ length: 32 }, () =>
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".charAt(
        Math.floor(Math.random() * 62),
      ),
    ).join("");

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "player.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "player.css"),
    );

    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `media-src ${webview.cspSource} data: blob:`,
      `connect-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    const templatePath = vscode.Uri.joinPath(this.context.extensionUri, "media", "player.html");
    const raw = await vscode.workspace.fs.readFile(templatePath);
    return Buffer.from(raw)
      .toString("utf8")
      .replace("{{CSP}}", csp)
      .replace("{{NONCE}}", nonce)
      .replace("{{STYLE}}", styleUri.toString())
      .replace("{{SCRIPT}}", scriptUri.toString());
  }

  private async loadInitial(): Promise<void> {
    this.tracks = await this.queueFor(this.sourceUri);
    this.index = Math.max(
      0,
      this.tracks.findIndex((track) => track.uri.toString() === this.sourceUri.toString()),
    );
    const autoplay = vscode.workspace.getConfiguration("myVSCPlayer").get<boolean>("autoplay", false);
    await this.pushTrack(this.index, autoplay);
  }

  private async select(index: number): Promise<void> {
    if (index < 0 || index >= this.tracks.length || index === this.index) {
      return;
    }
    this.index = index;
    await this.pushTrack(index, false);
  }

  private async pushTrack(index: number, autoplay: boolean): Promise<void> {
    const track = this.tracks[index];
    if (!track) {
      return;
    }

    const base = {
      type: "track",
      index,
      count: this.tracks.length,
      name: track.name,
      mime: MIME[path.extname(track.name).toLowerCase()] ?? "audio/mpeg",
      autoplay,
    };

    try {
      if (track.uri.scheme === "file") {
        /* Stream straight from disk: the webview gets a range-capable URL. */
        await this.panel.webview.postMessage({
          ...base,
          url: this.panel.webview.asWebviewUri(track.uri).toString(),
        });
      } else {
        /* Remote / virtual file systems: hand the bytes over as base64. */
        const bytes = await vscode.workspace.fs.readFile(track.uri);
        await this.panel.webview.postMessage({
          ...base,
          data: Buffer.from(bytes).toString("base64"),
        });
      }
      this.panel.title = track.name;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.panel.webview.postMessage({ type: "error", message });
    }
  }

  private applyStatus(name: string | undefined, playing: boolean): void {
    if (!statusBar) {
      return;
    }
    const label = name ?? this.tracks[this.index]?.name ?? "myVSCPlayer";
    statusBar.text = `${playing ? "$(unmute)" : "$(mute)"} ${label}`;
    statusBar.show();
  }

  private async postSep(phase: "running" | "done" | "error", message: string): Promise<void> {
    await this.panel.webview.postMessage({ type: "sep-state", phase, message });
  }

  private async separate(start: number, end: number): Promise<void> {
    const track = this.tracks[this.index];
    if (!track || this.separating) {
      return;
    }

    const from = Math.min(start, end);
    const to = Math.max(start, end);

    if (track.uri.scheme !== "file") {
      await this.postSep("error", "stem separation needs a local file");
      return;
    }
    if (to - from < 0.5) {
      await this.postSep("error", "select at least 0.5s");
      return;
    }

    const config = vscode.workspace.getConfiguration("myVSCPlayer");
    const demucs = (config.get<string>("demucsCommand", "demucs") || "demucs").trim();
    const model = (config.get<string>("stemModel", "htdemucs") || "htdemucs").trim();
    const device = (config.get<string>("demucsDevice", "") || "").trim();
    const ffmpeg = (config.get<string>("ffmpegPath", "ffmpeg") || "ffmpeg").trim();

    const songDir = path.dirname(track.uri.fsPath);
    const songName = path.basename(track.name, path.extname(track.name));
    const destDir = path.join(songDir, `${songName}_separated`);
    const work = await fs.mkdtemp(path.join(os.tmpdir(), "myvscplayer-"));
    const region = path.join(work, "region.wav");
    const outRoot = path.join(work, "out");

    this.separating = true;
    await this.postSep("running", `separating ${fmtClock(from)}–${fmtClock(to)}`);

    try {
      const written = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Separating stems — ${songName}`,
          cancellable: true,
        },
        async (progress, token) => {
          progress.report({ message: `slicing ${fmtClock(from)}–${fmtClock(to)}` });
          await runCommand(
            ffmpeg,
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-y",
              "-ss",
              from.toFixed(3),
              "-to",
              to.toFixed(3),
              "-i",
              track.uri.fsPath,
              "-vn",
              "-ac",
              "2",
              "-ar",
              "44100",
              region,
            ],
            token,
            progress,
          );

          progress.report({ message: `demucs ${model}` });
          const [command, ...preArgs] = demucs.split(/\s+/);
          await runCommand(
            command,
            [
              ...preArgs,
              ...(device ? ["-d", device] : []),
              "-n",
              model,
              "-o",
              outRoot,
              region,
            ],
            token,
            progress,
          );

          const sliced = await fs.stat(region).catch(() => undefined);
          if (!sliced || sliced.size < 44100 * 2 * 0.5) {
            throw new Error("the selected range produced almost no audio");
          }

          const stems = await collectStems(outRoot);
          if (stems.length === 0) {
            throw new Error("demucs produced no wav files");
          }

          await fs.mkdir(destDir, { recursive: true });
          const names: string[] = [];
          for (const stem of stems) {
            const target = await uniquePath(path.join(destDir, path.basename(stem)));
            await fs.copyFile(stem, target);
            names.push(path.basename(target));
          }
          return names;
        },
      );

      await this.postSep("done", `${path.basename(destDir)}: ${written.join(" ")}`);
      const pick = await vscode.window.showInformationMessage(
        `Stems saved to ${path.basename(destDir)} (${written.join(", ")})`,
        "Reveal",
      );
      if (pick === "Reveal") {
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(destDir));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Stem separation failed: ${message}`);
      await this.postSep("error", message);
    } finally {
      this.separating = false;
      await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async queueFor(uri: vscode.Uri): Promise<TrackEntry[]> {
    const single: TrackEntry[] = [{ uri, name: path.basename(uri.fsPath) }];
    const mode = vscode.workspace
      .getConfiguration("myVSCPlayer")
      .get<string>("queueMode", "folder");
    if (mode !== "folder" || (uri.scheme !== "file" && uri.scheme !== "vscode-remote")) {
      return single;
    }

    const folder = uri.with({ path: path.posix.dirname(uri.path) });
    let listing: [string, vscode.FileType][];
    try {
      listing = await vscode.workspace.fs.readDirectory(folder);
    } catch {
      return single;
    }

    const tracks = listing
      .filter(
        ([name, kind]) =>
          kind === vscode.FileType.File && AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase()),
      )
      .map(([name]) => ({ uri: vscode.Uri.joinPath(folder, name), name }))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
      );

    return tracks.length > 0 ? tracks : single;
  }
}

/* ---------- helpers ---------- */

function fmtClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function searchPath(): string {
  /* The extension host inherits launchd's PATH, not the login shell's, so
     demucs (~/.local/bin) and ffmpeg (/opt/homebrew/bin) need to be added. */
  const extra = [
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const current = (process.env.PATH || "").split(":").filter(Boolean);
  return Array.from(new Set([...current, ...extra])).join(":");
}

function runCommand(
  command: string,
  args: string[],
  token: vscode.CancellationToken,
  progress: vscode.Progress<{ message?: string }>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    log?.appendLine(`$ ${command} ${args.join(" ")}`);
    const child = spawn(command, args, {
      env: { ...process.env, PATH: searchPath() },
    });
    let lastLine = "";

    const onData = (chunk: Buffer): void => {
      const text = chunk.toString();
      log?.append(text);
      const lines = text
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter(Boolean);
      const line = lines[lines.length - 1];
      if (line && line !== lastLine) {
        lastLine = line;
        progress.report({ message: line.slice(0, 90) });
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const cancel = token.onCancellationRequested(() => child.kill("SIGTERM"));

    child.on("error", (error: NodeJS.ErrnoException) => {
      cancel.dispose();
      if (error.code === "ENOENT") {
        reject(
          new Error(
            `${command} not found. Install it, or point myVSCPlayer.demucsCommand / myVSCPlayer.ffmpegPath at it.`,
          ),
        );
      } else {
        reject(error);
      }
    });

    child.on("close", (code, signal) => {
      cancel.dispose();
      if (token.isCancellationRequested || signal) {
        reject(new Error("cancelled"));
      } else if (code === 0) {
        resolve();
      } else {
        const detail = lastLine ? `: ${lastLine}` : "";
        reject(new Error(`${path.basename(command)} exited with code ${code}${detail}`));
      }
    });
  });
}

async function collectStems(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (/\.wav$/i.test(entry.name)) {
        found.push(full);
      }
    }
  };
  await walk(root);
  return found.sort((a, b) => a.localeCompare(b));
}

async function uniquePath(target: string): Promise<string> {
  try {
    await fs.access(target);
  } catch {
    return target;
  }
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let i = 2; i < 1000; i += 1) {
    const candidate = path.join(dir, `${base}_${i}${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error("could not find a free file name");
}
