# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in **ccal**, please report it privately
rather than opening a public issue.

- Use GitHub's **[Report a vulnerability](https://github.com/rousan/ccal/security/advisories/new)**
  (Security → Advisories) to open a private advisory, **or**
- Contact the maintainer directly through the repository owner's GitHub profile.

Please include enough detail to reproduce the issue (steps, affected version, and
impact). We will acknowledge your report as soon as reasonably possible and keep
you informed about the fix and any coordinated disclosure.

## Supported versions

ccal is early-stage software. Security fixes are applied to the latest published
release on npm (`@rousan/ccal`). Please upgrade to the newest version before
reporting an issue.

## Security model — what to keep in mind

ccal is a **local developer tool**, and its threat model reflects that:

- **It shells out to a local CLI.** ccal spawns your installed `claude` binary as
  a subprocess for every chat request, using the flags documented in
  [docs/architecture.md](docs/architecture.md). It runs as a full Claude Code
  agent, so the `--cwd` you point it at determines which tools, MCP servers, and
  `CLAUDE.md` are loaded. Only run it in directories you trust, and be aware that
  `--permission-mode` can widen what the agent is allowed to do.
- **It binds to localhost by default.** The server listens on `127.0.0.1` unless
  you override `--host`. **Do not expose ccal to untrusted networks.** It has no
  authentication of its own — any client that can reach the port can drive your
  logged-in Claude subscription and any tools available in the working directory.
  If you bind to a non-loopback address, put it behind your own auth/proxy.
- **No API key is validated.** The `Authorization` header is ignored; auth is
  delegated entirely to your local `claude` login.

Treat the machine and working directory accordingly.
