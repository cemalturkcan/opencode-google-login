# Architecture

## Overview

OpenCode plugin that exposes a dedicated `Google (custom)` provider. It can complete Antigravity Google OAuth or Gemini CLI-style Google OAuth. The plugin persists multiple saved accounts, prefers Gemini CLI accounts for Gemini-backed models, rotates across accounts on model-capacity limits, and rewrites provider requests to the appropriate Cloud Code endpoint path.

## Module Layout

```
src/
├── index.ts         thin plugin definition and auth methods
├── constants.ts     provider constants, OAuth endpoints, Antigravity headers
├── auth-state.ts    packed refresh token helpers and refresh checks
├── account-store.ts persistent multi-account storage for Antigravity and Gemini CLI accounts
├── gemini-cli.ts    Gemini CLI OAuth, refresh, and user-agent helpers
├── logger.ts        JSONL debug logging, secret redaction
├── http.ts          fetchWithRetry (429, 529, retry-after)
├── credentials.ts   token refresh and user info lookup
├── oauth.ts         Google OAuth PKCE authorization + token exchange
├── oauth-server.ts  localhost callback listener for browser OAuth
├── project.ts       loadCodeAssist/onboardUser project resolution
├── schema.ts        tool schema cleanup for Antigravity compatibility
├── transforms.ts    request wrapping and Antigravity response unwrapping
└── fetch.ts         createCustomFetch — auth injection, refresh, endpoint routing
```

## Data Flow

```
OpenCode request
  → createCustomFetch (fetch.ts)
    → getAuth() to read current OAuth state
    → load stored Antigravity / Gemini CLI accounts and choose a candidate
    → refresh the matching OAuth flow if needed (credentials.ts or gemini-cli.ts)
    → resolve/persist effective project id (project.ts)
    → wrap provider request as { project, model, request } (transforms.ts)
    → fetch Antigravity or Gemini CLI-compatible Cloud Code request path
    → on capacity/rate-limit errors, cool down that account and retry with the next stored account
    → unwrap { response: ... } payloads back into Gemini provider responses
  → response back to OpenCode
```

## Key Design Decisions

### Project resolution is persisted inside the refresh string

The stored refresh field is packed as `refreshToken|projectId|managedProjectId`. That keeps auth state small while letting request handling reuse the resolved managed project without a fresh `loadCodeAssist` call on every request.

### Google (custom) is a separate provider entry

The plugin exposes provider id `google-custom` with display name `Google (custom)` so the built-in Google provider can coexist with it. Requests still reuse Google-compatible shapes internally, but authentication, model selection, and retry behavior are separate at the OpenCode provider layer.

### Multi-account rotation is file-backed

Antigravity accounts are persisted in a plugin-owned file under OpenCode state. Re-running login adds or updates an account in that file. When a request hits model-capacity/rate-limit exhaustion, the plugin cools that account down temporarily and retries with the next stored account.

### Gemini models prefer Gemini CLI accounts

For Gemini-backed Antigravity models, the plugin prefers saved `gemini-cli` accounts before Antigravity accounts so Gemini CLI quotas are consumed first. Claude-backed Antigravity models continue to use only Antigravity accounts.

### CLI-only state hides Claude models

If the saved account store only contains `gemini-cli` accounts, the provider catalog only exposes Gemini models. Claude models become visible again only when at least one Antigravity account exists.

### Schema cleanup is the main request mutation

Antigravity is stricter than the public Gemini endpoint for tool schemas. `schema.ts` removes unsupported keywords and folds validation hints into descriptions so OpenCode tool definitions remain usable without changing the upstream tool surface.

### Browser auto-open is local-only

Browser OAuth methods auto-open the authorization URL only after the localhost callback listener is successfully bound. Headless or remote flows stay manual and only show the URL.

## Environment Variables

| Variable                 | Purpose                                        |
| ------------------------ | ---------------------------------------------- |
| `ANTIGRAVITY_AUTH_DEBUG` | Disable debug logging (`0` or `false`)         |
| `ANTIGRAVITY_VERSION`    | Override the Antigravity version in User-Agent |
| `OPENCODE_HEADLESS`      | Force manual OAuth flow instead of localhost   |
