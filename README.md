# TapoStudio

Desktop app scaffold for monitoring multiple Tapo cameras on Windows and Linux.  
Note: this app was basically fully written with the help of AI, while I did fully oversee all code changes, this is my first Electron application.

## Legal disclaimer

- This project is an independent, community-driven tool and is not affiliated with, endorsed by, or sponsored by TP-Link.
- Any Tapo API communication in this project relies on publicly observable behavior and/or third-party reverse-engineered integrations, which may change or stop working at any time.
- `Tapo`, `TP-Link`, and related names, logos, and product marks are trademarks of their respective owners.
- Use this software only with devices and accounts you own or are authorized to access, and ensure your usage complies with applicable laws and the vendor's terms.
- This repository is provided for educational and interoperability purposes and does not constitute legal advice.

## Current shape

- Electron shell with a React + TypeScript renderer.
- Primary viewer area for a maximized selected camera.
- Preview grid for switching between cameras.
- Timeline strip ready for local-recording scrubbing.

## Next integration points

- Add a Tapo device adapter for live streams and camera discovery.
- Add SD-card recording index / clip lookup.
- Replace the static camera data with real device state and motion events.

## Development

Install dependencies, then run the dev shell:

```bash
npm install
npm run dev
```

## Testing

Run the unit tests with:

```bash
npm run test:unit
```

Run the real Electron smoke test, which builds the app and launches it against an isolated temp profile:

```bash
npm run test:e2e
```

For manual automation runs, set `TAPOSTUDIO_USER_DATA_DIR` to isolate config and logs from your normal profile. The main process writes a `tapostudio.log` file inside that directory and exposes the active runtime paths through `window.tapoStudio.diagnostics.getRuntimeInfo()`.

## Releases

Build distributables with electron-builder:

```bash
# unpacked app directory (quick packaging smoke test)
npm run package

# Windows portable .exe
npm run release:win

# Linux portable AppImage
npm run release:linux
```

Artifacts are written to `release/`.

Notes:

- `release:win` should be run on Windows.
- `release:linux` should be run on Linux (or in a Linux CI runner/container).

## Requirements

- Node.js 20 or newer
- npm available on PATH