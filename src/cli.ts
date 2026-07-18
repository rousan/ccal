#!/usr/bin/env node
// The `ccal` command-line entry point. It supports a single `serve` subcommand
// that starts the OpenAI-compatible HTTP server:
//
//   ccal serve [--port <n>] [--host <addr>] [--cwd <dir>] [--permission-mode <m>]
//
// We keep argument parsing deliberately small and dependency-free — the surface
// is tiny, so a hand-rolled parser is clearer than pulling in a CLI framework.

import { serve } from "@hono/node-server";

import { createServer } from "./server.js";
import { checkClaude } from "./claude-binary.js";

// Parsed options for the `serve` subcommand.
interface ServeOptions {
  port: number;
  host: string;
  cwd?: string;
  permissionMode?: string;
}

// Default port and host, chosen to match the value documented in the README and
// used by OpenAI-compatible clients pointed at this adapter.
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";

// Parse the flags following the `serve` subcommand. Supports both `--flag value`
// and `--flag=value` forms. Unknown flags cause a friendly error.
function parseServeArgs(args: string[]): ServeOptions {
  const options: ServeOptions = { port: DEFAULT_PORT, host: DEFAULT_HOST };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Support --flag=value by splitting on the first '='.
    const eq = arg.indexOf("=");
    let flag = arg;
    let inlineValue: string | undefined;
    if (arg.startsWith("--") && eq !== -1) {
      flag = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }

    // Read the value from the inline form or the next argument.
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = args[i + 1];
      if (next === undefined) {
        fail(`Missing value for ${flag}`);
      }
      i++;
      return next;
    };

    switch (flag) {
      case "--port":
      case "-p": {
        const value = takeValue();
        const port = Number.parseInt(value, 10);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          fail(`Invalid port: ${value}`);
        }
        options.port = port;
        break;
      }
      case "--host":
        options.host = takeValue();
        break;
      case "--cwd":
        options.cwd = takeValue();
        break;
      case "--permission-mode":
        options.permissionMode = takeValue();
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }

  return options;
}

// Print an error to stderr and exit with a non-zero status.
function fail(message: string): never {
  console.error(`ccal: ${message}`);
  process.exit(1);
}

// Print usage help.
function printHelp(): void {
  console.log(
    [
      "ccal — Claude Code Adapter for LLMs",
      "",
      "An OpenAI-compatible HTTP server that proxies to the local `claude` CLI.",
      "",
      "Usage:",
      "  ccal serve [options]",
      "",
      "Options:",
      "  --port <n>              Port to bind (default: 8787)",
      "  --host <addr>           Host to bind (default: 127.0.0.1)",
      "  --cwd <dir>             Working directory for the claude process",
      "  --permission-mode <m>   Permission mode passed to claude (non-default only)",
      "  --help                  Show this help",
      "",
      "Once running, point any OpenAI-compatible client at:",
      "  http://127.0.0.1:8787/v1",
    ].join("\n"),
  );
}

function main(): void {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    return;
  }

  const command = argv[0];
  if (command !== "serve") {
    fail(`Unknown command: ${command}. Try 'ccal serve'.`);
  }

  // Allow `ccal serve --help` to print usage rather than start the server.
  const rest = argv.slice(1);
  if (rest.includes("--help")) {
    printHelp();
    return;
  }

  const options = parseServeArgs(rest);

  // Probe for the claude binary so we can log its location or warn early. This
  // is informational only; the server still starts and will report a clear 502
  // per request if claude cannot be found later.
  const claude = checkClaude();
  const config = { cwd: options.cwd, permissionMode: options.permissionMode };
  const app = createServer(config);

  serve({ fetch: app.fetch, port: options.port, hostname: options.host }, (info) => {
    const base = `http://${options.host}:${info.port}`;
    console.log(`ccal listening on ${base}`);
    console.log(`OpenAI-compatible base URL: ${base}/v1`);
    if (claude.available) {
      const version = claude.version ? ` (${claude.version})` : "";
      console.log(`Using claude CLI at ${claude.path}${version}`);
    } else {
      console.warn(
        "WARNING: could not find the `claude` CLI. Install it and log in " +
          "(https://docs.claude.com/claude-code), or set CCAL_CLAUDE_PATH. " +
          "Requests to /v1/chat/completions will fail with 502 until it is found.",
      );
    }
  });
}

main();
