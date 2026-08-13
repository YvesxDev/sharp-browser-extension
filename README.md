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

Use Node.js 22.12 or newer. The repository's `.nvmrc` pins the tested version:

```sh
nvm install
nvm use
```

```sh
npm ci
npm run typecheck
npm run build
```

If WXT fails during `Generating types...` with `Cannot read properties of undefined`, verify `node --version`, remove the existing `node_modules`, and run `npm ci` under the pinned Node version.

Load `load-this-folder` as an unpacked Chrome extension.

## Remote clients

Remote clients can be added in **Settings → Remote Sharp** with the same API-key and Discord authorization flow used by the Sharp WebUI. The extension discovers the assigned server, asks for explicit access to that HTTPS host, and connects to ports 8686–8696. WebUI-initiated **Pair Extension** offers remain supported.

## Release

```sh
npm run zip
```
"Vibe" coded chrome extension layer on top of Sharp CLI
