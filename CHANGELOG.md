# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-07-19

### Added

- **Image input.** `image_url` content parts in a chat request (both
  `data:` base64 URLs and remote http(s) URLs) are now forwarded to `claude`
  as image content blocks via its stream-json input, instead of being silently
  dropped. Vision models (`sonnet`, `opus`, `haiku`) can now actually see
  attached images. Text-only requests are unchanged.

## [1.2.0] - 2026-07-19

### Added

- `ccal version` (and `--version` / `-v`) prints the installed version.
- `ccal update` checks npm for a newer release and self-updates via
  `npm install -g` when one is available.

## [1.1.0] - 2026-07-19

### Added

- `GET /v1/models` now returns OpenRouter-style catalog metadata per model
  (context length, input modalities, supported parameters, description) so
  metadata-aware clients can show context size and capability badges. Plain
  OpenAI clients ignore the extra fields.

## [1.0.0] - 2026-07-18

### Added

- Initial release of **ccal** — an OpenAI-compatible HTTP server that proxies to
  the local `claude` CLI.
- `ccal serve` command with `--port`, `--host`, `--cwd`, and `--permission-mode`
  options, plus the `CCAL_CLAUDE_PATH` environment override.
- Endpoints:
  - `GET /health` — liveness probe.
  - `GET /v1/models` — advertises the `sonnet`, `opus`, and `haiku` model ids.
  - `POST /v1/chat/completions` — OpenAI-compatible chat completions with both
    streaming (SSE) and non-streaming responses.
- Translation of the `claude` CLI's `stream-json` output into OpenAI chunks,
  including compact one-line notes for tool calls.
- `claude` binary resolution across `CCAL_CLAUDE_PATH`, `PATH`, the login shell,
  and common install locations.
- Permissive CORS for browser and webview clients.

[Unreleased]: https://github.com/rousan/ccal/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/rousan/ccal/releases/tag/v1.3.0
[1.2.0]: https://github.com/rousan/ccal/releases/tag/v1.2.0
[1.1.0]: https://github.com/rousan/ccal/releases/tag/v1.1.0
[1.0.0]: https://github.com/rousan/ccal/releases/tag/v1.0.0
