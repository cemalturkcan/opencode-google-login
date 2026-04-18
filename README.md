# OpenCode Antigravity Auth

[OpenCode](https://github.com/sst/opencode) plugin that adds a dedicated Antigravity provider. It can use either Antigravity login or Gemini CLI-style Google OAuth, keeps multiple saved accounts, and rotates across them when one account hits model capacity limits.

## Features

### Installed app import

If Antigravity is installed and already logged in, the plugin can pull the desktop session from Antigravity's local state database and convert it into a fresh OAuth token set for OpenCode.

### Cross-Platform Support

Works on **macOS**, **Linux**, and **Windows**.

### Browser OAuth fallback

If the desktop import path is unavailable, the plugin starts a Google OAuth flow with PKCE. On local machines it listens for the localhost callback automatically; on headless or remote sessions it falls back to manual callback paste.

### Multiple accounts

Each successful Antigravity login is stored in plugin state, so you can add more than one Antigravity account over time.

### Gemini CLI-backed Gemini models

If you connect a Gemini CLI-style Google account, Gemini-capable Antigravity models prefer that quota path automatically, while Claude Antigravity models keep using the Antigravity backend.

### Automatic account rotation

If one Antigravity account hits model capacity or rate limits, the plugin temporarily cools that account down and retries the same request with the next stored Antigravity account.

### Antigravity request rewriting

OpenCode still talks to the standard Google provider surface. The plugin intercepts those Gemini requests, wraps them for Antigravity's internal Cloud Code API, and unwraps the response envelope on the way back.

### Project auto-resolution

The plugin resolves the effective Antigravity project with `loadCodeAssist` and stores it alongside the refresh token so subsequent requests do not need to rediscover it.

### Tool schema cleanup

Antigravity is stricter than the public Gemini endpoint for tool schemas. The plugin strips unsupported JSON Schema fields and converts them into description hints so tool calling keeps working.

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-antigravity-login@latest"]
}
```

Then open OpenCode and go to **Connect Provider > Google (custom)**.

### Updating

OpenCode caches plugin packages in `~/.cache/opencode/node_modules/`. If you pin to a specific version and later bump it (or re-install the same version after a patch), OpenCode may keep loading the cached copy. If requests still behave like the old version after an update, clear the cache:

```bash
rm -rf ~/.cache/opencode/node_modules/
```

Then restart OpenCode — it will re-download the plugin on next launch.

## Auth Methods

| Method  | Label                  | How it works                                                       |
| ------- | ---------------------- | ------------------------------------------------------------------ |
| Auto    | Antigravity app (auto) | Imports the installed desktop session from `state.vscdb`           |
| Browser | Antigravity (browser)  | Antigravity's Google OAuth with localhost callback or manual paste |
| Browser | Google (Gemini CLI)    | Gemini CLI-style Google OAuth for Gemini-backed quotas             |

## License

MIT
