# Privacy

Sharp Trading stores extension settings and optional Sharp connection credentials in Chrome extension-local storage. Credential storage is restricted to trusted extension contexts and is not exposed to supported trading pages.

The extension connects only to:

- Sharp clients configured by local discovery or an explicitly approved WebUI pairing;
- the supported trading-site origins needed for injected controls.

It does not sell personal data, inject analytics, or send browsing history to Sharp. While a supported token page is open, its token or pool address and originating site may be sent to the selected Sharp client to resolve and prewarm price data. Trade details are sent when the user submits a trade.

Users can remove all paired remote credentials from **Settings → Disconnect and wipe remote credentials**, or remove all extension data through Chrome.
