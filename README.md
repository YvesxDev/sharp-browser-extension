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

## Remote clients

Remote clients can be added in **Settings → Remote Sharp** with the same API-key and Discord authorization flow used by the Sharp WebUI. The extension discovers the assigned server, asks for explicit access to that HTTPS host, and connects to ports 8686–8696. WebUI-initiated **Pair Extension** offers remain supported.

## Release

```sh
npm run zip
```
"Vibe" coded chrome extension layer on top of Sharp CLI
