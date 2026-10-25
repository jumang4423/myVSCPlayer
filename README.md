# myVSCPlayer

An audio player that lives inside VS Code. Open an `.mp3` and you get a waveform you can
click into, a queue built from the folder, keyboard transport, and the current track in the
status bar — instead of the built-in one-line `<audio>` control.

## Features

- **Custom editor for audio files** — `.mp3 .wav .flac .m4a .m4b .aac .ogg .oga .opus .aiff .aif .weba`
- **Waveform** — drawn from the decoded samples, click or drag anywhere to seek, playhead
  coloured against the elapsed portion
- **Folder queue** — prev/next walk the other audio files in the same folder (name-sorted,
  numeric-aware), auto-advance on track end
- **Transport** — play/pause, ±5s seek, speed 0.5x–2x, loop, volume
- **Speed moves the pitch** — playback is tape-style (`preservesPitch = false`), so 2x sounds an
  octave up instead of being time-stretched; 0.5x drops an octave
- **Keyboard** — `Space` `←` `→` `↑` `↓` `N` `P` `L` `Home` `End`
- **Status bar** — shows the current track, click to reveal the player
- **Persistence** — volume, speed and loop survive reopening the tab
- **Remote-friendly** — bytes are read through `vscode.workspace.fs`, so Remote SSH and
  Dev Containers play locally in the webview

## Install (from source)

```sh
git clone https://github.com/jumang4423/myVSCPlayer.git
cd myVSCPlayer
npm install
npm run compile
npx @vscode/vsce package
code --install-extension myvscplayer-0.1.0.vsix
```

Or press `F5` in VS Code with this folder open to run the extension host.

To check the webview layout without launching VS Code, render the real files in a browser:

```sh
node test/preview.mjs "/path/to/track.mp3" /tmp/myvsc-preview
cd /tmp/myvsc-preview && python3 -m http.server 8765
# open http://127.0.0.1:8765/index.html
```

If another extension already claims audio files, right-click the file →
**Reopen Editor With… → myVSCPlayer**, or pin it in `settings.json`:

```jsonc
"workbench.editorAssociations": {
  "*.mp3": "myVSCPlayer.audio",
  "*.wav": "myVSCPlayer.audio"
}
```

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `myVSCPlayer.autoplay` | `false` | Start playing when a file is opened |
| `myVSCPlayer.queueMode` | `folder` | `folder` builds the queue from sibling audio files, `single` disables prev/next |

## How it works

`src/extension.ts` registers a `CustomReadonlyEditorProvider` for `myVSCPlayer.audio`.

- **Local files** are streamed straight from disk: the extension host adds the file's folder to
  `localResourceRoots` and hands the webview a `webview.asWebviewUri` URL, so the browser engine
  range-requests the audio instead of copying it.
- **Remote / virtual file systems** (`vscode-remote`, etc.) cannot be reached by the local webview,
  so the bytes are read with `vscode.workspace.fs.readFile` and posted as base64.
- The waveform is built from `AudioContext.decodeAudioData` on a copy of the same source; nothing
  is written to disk and no network is used.

## Limitations

- One panel plays at a time; opening a second file pauses nothing automatically yet
- No playlist file support (`.m3u`) yet, no tags/cover art yet
- Remote sessions send the whole file as base64, which is heavy for very large files

## Roadmap

- A/B loop regions
- Drag-and-drop queue, `.m3u` import
- ID3/FLAC tag + cover art display
- Media key handling where the webview allows it

## License

MIT
