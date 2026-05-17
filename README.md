# TapoStudio

Desktop app scaffold for monitoring multiple Tapo cameras on Windows and Linux.

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

## Requirements

- Node.js 20 or newer
- npm available on PATH