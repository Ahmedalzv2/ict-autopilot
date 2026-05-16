# ICT AutoPilot

Single-page trading dashboard for ICT (Inner Circle Trader) setups across
crypto, futures, and US100. Auto-executes scalp trades on MEXC perp for
a configured asset trio when 1m FVG signals fire.

Hosted on GitHub Pages — open `index.html` directly or visit the live
URL: <https://ahmedalzv2.github.io/ict-autopilot/>.

## Files

| File          | Role                                                       |
|---------------|------------------------------------------------------------|
| `index.html`  | Main dashboard. All app logic + UI.                        |
| `styles.css`  | Theme + layout. Linked by `index.html`.                    |
| `us100.html`  | Standalone US100 (NASDAQ) futures view.                    |
| `worker.js`   | Cloudflare Worker that proxies signed MEXC contract calls. |
| `tests/`      | Node-native test suite (`npm test`, ~2s).                  |
| `CLAUDE.md`   | Operating manual for the Claude Code agent.                |

## Deploy

The browser app is static — push to `main` and GitHub Pages serves it.
The Worker deploys separately to Cloudflare (see header comment in
`worker.js` for steps).

## Tests

```sh
npm test
```

Tests are pure JS, no build step. Run before every push.
