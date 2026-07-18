# Contributing to ccal

Thanks for your interest in improving **ccal**! Contributions of all kinds are
welcome — bug reports, docs, and code.

## Getting started

1. Make sure you have **Node 20+** and **pnpm** installed, plus the
   [`claude`](https://docs.claude.com/claude-code) CLI installed and logged in
   (ccal drives it, so you need it to test end to end).
2. Fork and clone the repo.
3. Install dependencies:

   ```sh
   pnpm install
   ```

4. Run the server from source:

   ```sh
   pnpm dev            # tsx src/cli.ts serve
   ```

See [docs/development.md](docs/development.md) for the full development guide,
including how to test locally with `curl`.

## Before you open a pull request

- **Typecheck:** `pnpm typecheck` must pass with no errors.
- **Build:** `pnpm build` must succeed and produce a runnable `dist/cli.js`.
- **Manual smoke test:** start the server and hit `GET /v1/models` and
  `POST /v1/chat/completions` to confirm nothing regressed.
- Keep the code style consistent with what's already there: plain, well-commented
  TypeScript, no emoji in source, and small dependency-free helpers over new
  packages where reasonable.

## Commit and PR conventions

- Write clear, present-tense commit messages describing the change.
- Keep pull requests focused — one logical change per PR is easier to review.
- Update the docs (README, `docs/`, `CHANGELOG.md`) when your change affects
  behavior, flags, or endpoints.
- Add an entry under the `Unreleased` section of
  [CHANGELOG.md](CHANGELOG.md).

## Reporting bugs and requesting features

Please use the GitHub issue templates:

- **Bug report** — for something that doesn't work as documented.
- **Feature request** — for new capabilities or improvements.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating, you agree to uphold it.
