# OpenCode Google Login

[OpenCode](https://github.com/sst/opencode) plugin that adds a **Google (custom)** provider. It can use either Antigravity login or Gemini CLI-style Google OAuth, keeps multiple saved accounts, hides Claude models when only Gemini CLI auth exists, and rotates across accounts when one account hits model capacity limits.

## Features

### Installed App Import

If Antigravity is installed and already logged in, the plugin can pull the desktop session from Antigravity's local state database and convert it into a fresh OAuth token set for OpenCode.

### Cross-Platform Support

Works on **macOS**, **Linux**, and **Windows**.

### Browser Login

Starts a Google OAuth flow with PKCE. On local machines it binds a localhost callback and opens the browser automatically. On headless or remote sessions it falls back to manual URL copy/paste.

### Multiple Accounts

Each successful Antigravity login is stored in plugin state, so you can add more than one Antigravity account over time.

### Gemini CLI Routing

If you connect a Gemini CLI-style Google account, Gemini models prefer that quota path automatically, while Claude models keep using the Antigravity backend.

### Model Visibility

If your saved accounts only contain Gemini CLI auth, the provider catalog only shows Gemini models. Claude models appear only when at least one Antigravity account exists.

### Automatic Account Rotation

If one Antigravity account hits model capacity or rate limits, the plugin temporarily cools that account down and retries the same request with the next stored Antigravity account.

### Request Rewriting

OpenCode still talks to the standard Google provider surface. The plugin intercepts those requests, rewrites them to Cloud Code request bodies, routes Gemini models through Gemini CLI-compatible paths when available, and unwraps the response envelope on the way back.

### Project Auto-Resolution

The plugin resolves the effective Antigravity project with `loadCodeAssist` and stores it alongside the refresh token so subsequent requests do not need to rediscover it.

### Tool Schema Cleanup

Antigravity is stricter than the public Gemini endpoint for tool schemas. The plugin strips unsupported JSON Schema fields and converts them into description hints so tool calling keeps working.

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-google-login@latest"]
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

| Method  | Label                     | How it works                                                       |
| ------- | ------------------------- | ------------------------------------------------------------------ |
| Auto    | Antigravity app (auto)    | Imports the installed desktop session from `state.vscdb`           |
| Browser | Antigravity (browser)     | Antigravity's Google OAuth with localhost callback or manual paste |
| Browser | Google (Gemini CLI)       | Gemini CLI-style Google OAuth for Gemini-backed quotas             |
| Manage  | Remove saved account      | Removes one saved Google (custom) account                          |
| Manage  | Remove all saved accounts | Clears all saved Google (custom) accounts                          |

## Models

Canonical model ids exposed by the provider:

- `google-custom-gemini-3-flash`
- `google-custom-gemini-3-pro`
- `google-custom-gemini-3.1-pro`
- `google-custom-claude-sonnet-4-6`
- `google-custom-claude-opus-4-6-thinking`

Notes:

- `google-custom-gemini-3.1-pro` routes through Gemini CLI as `gemini-3.1-pro-preview`

## License

MIT
