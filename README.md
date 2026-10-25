# myVSCPlayer

An audio player that lives inside VS Code. Open an `.mp3` and you get a waveform you can
click into, a queue built from the folder, keyboard transport, and the current track in the
status bar — instead of the built-in one-line `<audio>` control.

## Features

- **Custom editor for audio files** — `.mp3 .wav .flac .m4a .m4b .aac .ogg .oga .opus .aiff .aif .weba`
- **Waveform** — drawn from the decoded samples, click or drag anywhere to seek, playhead
  coloured against the elapsed portion. The file is streamed and decoded in 512 KB slices, so
  the first pixels land in a fraction of a second and the rest fills in as it decodes
- **Folder queue** — prev/next walk the other audio files in the same folder (name-sorted,
  numeric-aware), auto-advance on track end
- **Transport** — play/pause, ±5s seek, speed 0.5x–2x, loop, volume
- **Speed moves the pitch** — playback is tape-style (`preservesPitch = false`), so 2x sounds an
  octave up instead of being time-stretched; 0.5x drops an octave
- **Keyboard** — `Space` `←` `→` `↑` `↓` `N` `P` `L` `Home` `End`
- **Status bar** — shows the current track, click to reveal the player
- **SEP** — drag a range on the waveform and stem-separate just that range into
  `<song>_separated/` (needs demucs)
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

## Stem separation (SEP)

1. Press **SEP** (left of `LOOP`) — the panel goes into range mode.
2. Drag across the waveform. On release, that range is separated.
3. Results land in `<songname>_separated/` next to the audio file:
   `vocals.wav`, `drums.wav`, `bass.wav`, `other.wav`.
   Later runs never overwrite: they write `vocals_2.wav`, `vocals_3.wav`, …

Pipeline: `ffmpeg -ss A -to B` cuts the range to a temp wav → `demucs -n htdemucs -o <tmp>` →
the four stems are copied into place, and the temp directory is removed. `Esc` clears the
selection and leaves range mode.

Requirements (Apple Silicon):

```sh
# arm64 native build; torch/torchaudio are pinned because demucs 4.0.1
# predates the torchaudio API change and torch 2.x needs numpy<2
uv tool install demucs \
  --with "torch==2.0.0" --with "torchaudio==2.0.0" \
  --with "numpy<2" --with "setuptools<81"

brew install ffmpeg        # ffmpeg must be on PATH
```

Measured on an M1 Pro (12 s of stereo 44.1 kHz): **CPU 16 s**, `-d mps` 20 s. MPS runs
(some ops fall back to CPU), but CPU is faster for htdemucs, so `myVSCPlayer.demucsDevice`
defaults to empty (= demucs' own default, i.e. CPU on macOS). Set it to `mps` if you want to
experiment with the GPU.

The extension host does not inherit your login shell's `PATH`, so `~/.local/bin`,
`/opt/homebrew/bin` and `/usr/local/bin` are appended before spawning ffmpeg/demucs.

Settings: `myVSCPlayer.demucsCommand` (default `demucs`, also accepts `python3 -m demucs`),
`myVSCPlayer.stemModel` (default `htdemucs`), `myVSCPlayer.demucsDevice`, `myVSCPlayer.ffmpegPath`.
Only local files are supported; separation is skipped for remote/virtual documents.

## How it works

`src/extension.ts` registers a `CustomReadonlyEditorProvider` for `myVSCPlayer.audio`.

- **Local files** are streamed straight from disk: the extension host adds the file's folder to
  `localResourceRoots` and hands the webview a `webview.asWebviewUri` URL, so the browser engine
  range-requests the audio instead of copying it.
- **Remote / virtual file systems** (`vscode-remote`, etc.) cannot be reached by the local webview,
  so the bytes are read with `vscode.workspace.fs.readFile` and posted as base64.
- The waveform is built from `AudioContext.decodeAudioData` on a copy of the same source; nothing
  is written to disk and no network is used.

### Waveform decoding

`player.js` reads the response as a stream and decodes it every 512 KB instead of waiting for the
whole file. Each decoded slice is reduced to 2048 min/max bins (sampling ~48 points per bin, so the
reduction is cheap), and the bins are re-mapped onto the current canvas width on every draw and on
resize. Measured on a 21 MB / 22:29 mp3: **first pixels ≈ 0.3 s, complete waveform ≈ 1.8 s**
(previously the panel stayed empty until the whole file had decoded). Formats other than mp3/wav,
and `data:` sources, fall back to a single full decode.

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
