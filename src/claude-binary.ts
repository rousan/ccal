// Locating the `claude` CLI on the host. This mirrors the resolution order used
// by the original Rust adapter, because the exact same problem applies here: a
// process may be launched with a minimal PATH (for example a GUI app, or `npx`
// spawned from an editor) that omits the directories where `claude` typically
// lives, such as ~/.local/bin. We therefore try several strategies in order and
// return the first path that actually exists on disk.

import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, delimiter } from "node:path";
import { homedir } from "node:os";

// Result of probing the system for the `claude` binary. `path` is the absolute
// path we resolved, and `version` is the trimmed output of `claude --version`
// when we were able to run it.
export interface ClaudeInfo {
  available: boolean;
  path: string | null;
  version: string | null;
}

// Walk the PATH environment variable looking for an executable file named `bin`.
// We only check for existence as a file; we do not attempt to verify the execute
// bit, because on some setups the file is a symlink or wrapper that still runs
// fine and stat of the target is enough of a signal.
function findInPath(bin: string): string | null {
  const path = process.env.PATH;
  if (!path) return null;
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Missing entry or unreadable directory — just skip it.
    }
  }
  return null;
}

// Resolve the absolute path to the `claude` binary, or null if we cannot find
// it. The strategies, in order:
//   1. An explicit override via the CCAL_CLAUDE_PATH environment variable.
//   2. A scan of the current PATH.
//   3. Asking the user's login shell (`$SHELL -lic 'command -v claude'`), which
//      sources their rc files and therefore sees the PATH they normally have.
//   4. A short list of common absolute install locations.
export function resolveClaude(): string | null {
  // 1. Explicit override. We keep this first so a user can always force a
  //    specific binary regardless of what is on PATH.
  const override = process.env.CCAL_CLAUDE_PATH;
  if (override && existsSync(override)) {
    return override;
  }

  // 2. Scan the current PATH.
  const onPath = findInPath("claude");
  if (onPath) {
    return onPath;
  }

  // 3. Ask the login shell. This is the strategy that recovers ~/.local/bin and
  //    other rc-managed additions when we were launched with a stripped PATH.
  const shell = process.env.SHELL;
  if (shell) {
    try {
      const out = execFileSync(shell, ["-lic", "command -v claude"], {
        encoding: "utf8",
        // The command is trivial; cap it so a misbehaving rc file can't hang us.
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const line = out
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (line && existsSync(line)) {
        return line;
      }
    } catch {
      // Shell missing, non-zero exit, or timeout — fall through to step 4.
    }
  }

  // 4. Common absolute install locations, checked in the same order the Rust
  //    adapter used.
  const home = homedir();
  const candidates = [
    join(home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

// Probe for the binary and, when found, try to read its version string. This is
// used at startup to print a helpful log line (and warn when the CLI is
// missing). A failure to read the version is non-fatal — we still report the
// binary as available.
export function checkClaude(): ClaudeInfo {
  const path = resolveClaude();
  if (!path) {
    return { available: false, path: null, version: null };
  }
  let version: string | null = null;
  try {
    const out = execFileSync(path, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    version = trimmed.length > 0 ? trimmed : null;
  } catch {
    // Version probe failed; the binary still exists, so leave version null.
  }
  return { available: true, path, version };
}
