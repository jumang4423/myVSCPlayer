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

export function activate(context: vscode.ExtensionContext): void {
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
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };

    webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== "object") {
        return;
      }
      const msg = message as { type?: string; index?: number; name?: string; playing?: boolean };

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
      }
    });

    webview.html = this.html(webview);
    this.panel.title = path.basename(this.sourceUri.fsPath);
  }

  private html(webview: vscode.Webview): string {
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

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; media-src blob: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${styleUri}" />
<title>myVSCPlayer</title>
</head>
<body>
  <header class="bar">
    <div class="title">
      <span id="track-name">Loading…</span>
      <span id="track-meta" class="meta"></span>
    </div>
    <div class="badges">
      <span id="track-index" class="badge"></span>
    </div>
  </header>

  <section class="wave">
    <canvas id="wave"></canvas>
    <div id="wave-hint" class="hint">decoding…</div>
  </section>

  <footer class="bar controls">
    <div class="group">
      <button id="prev" class="icon" title="Previous (P)">⏮</button>
      <button id="play" class="icon play" title="Play / pause (Space)">▶</button>
      <button id="next" class="icon" title="Next (N)">⏭</button>
    </div>
    <div class="group">
      <span id="time">0:00</span>
      <span class="sep">/</span>
      <span id="duration">0:00</span>
    </div>
    <div class="group">
      <button id="loop" class="icon" title="Loop (L)">⟲</button>
      <select id="rate" title="Speed">
        <option value="0.5">0.5x</option>
        <option value="0.75">0.75x</option>
        <option value="1" selected>1x</option>
        <option value="1.25">1.25x</option>
        <option value="1.5">1.5x</option>
        <option value="2">2x</option>
      </select>
      <input id="volume" type="range" min="0" max="1" step="0.01" value="1" title="Volume (↑ / ↓)" />
    </div>
  </footer>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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
    try {
      const bytes = await vscode.workspace.fs.readFile(track.uri);
      void this.panel.webview.postMessage({
        type: "track",
        index,
        count: this.tracks.length,
        name: track.name,
        autoplay,
        bytes,
      });
      this.panel.title = track.name;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void this.panel.webview.postMessage({ type: "error", message });
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
      .filter(([name, kind]) => kind === vscode.FileType.File && AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase()))
      .map(([name]) => ({ uri: vscode.Uri.joinPath(folder, name), name }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

    return tracks.length > 0 ? tracks : single;
  }
}
