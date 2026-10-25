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

`src/extension.ts` registers a `CustomReadonlyEditorProvider` for `myVSCPlayer.audio`. When a
webview asks for a track, the extension host reads the bytes with `vscode.workspace.fs.readFile`
and posts them into the webview, which plays them from a `Blob` URL and decodes a copy with
`AudioContext.decodeAudioData` to build the waveform. Nothing is written to disk and no network
is used.

## Limitations

- One panel plays at a time; opening a second file pauses nothing automatically yet
- Waveform redraws only on load, so resizing the panel needs a reopen
- No playlist file support (`.m3u`) yet, no tags/cover art yet
- Seeking is whole-file in memory: very large files are read entirely

## Roadmap

- A/B loop regions
- Drag-and-drop queue, `.m3u` import
- ID3/FLAC tag + cover art display
- Media key handling where the webview allows it

## License

MIT
