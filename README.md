# Sharp Trading browser extension

Sharp Trading adds Sharp controls to supported trading sites when a compatible Sharp client is connected

## Supported sites

- Axiom
- Padre / Terminal
- GMGN
- BasedBot
- Pump.fun
- Fomo
- DEX Screener

## Build

```sh
npm ci
npm run typecheck
npm run build
```

Load `load-this-folder` as an unpacked Chrome extension.

## Release

```sh
npm run zip
```
"Vibe" coded chrome extension layer on top of Sharp CLI
