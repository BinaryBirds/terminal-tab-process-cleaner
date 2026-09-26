# Terminal Tab Process Cleaner

A macOS-first VS Code extension that tracks processes started below each local integrated terminal and cleans them up when that terminal tab is closed.

## What it does

- Tracks descendants of every local terminal shell using the macOS process table.
- When a terminal is closed by the user, sends `SIGTERM` (or `SIGINT`) to the descendants it observed.
- After the configured grace period, optionally sends `SIGKILL` to any matching processes that remain.
- Avoids killing the terminal shell itself.
- Supports exclusions by executable name or command-line fragment.
- Includes a dry-run mode and an output channel for auditing.

The extension intentionally signals individual processes instead of killing an entire process group. This reduces the chance of terminating an unrelated process that happens to share a process group.

## Install from source

```sh
npm install
npm run compile
npm run package
```

Then install the generated `.vsix` from VS Code with **Extensions: Install from VSIX...**.

## Settings

The defaults are enabled, with a 500 ms polling interval, a 1.5 second grace period, and force-kill enabled. To inspect what will happen first, set:

```json
{
  "terminalProcessCleaner.dryRun": true,
  "terminalProcessCleaner.logLevel": "verbose"
}
```

Useful exclusions include:

```json
{
  "terminalProcessCleaner.excludeProcessNames": ["ssh", "tmux"],
  "terminalProcessCleaner.excludeCommands": ["my-important-server"]
}
```

## Commands

- **Terminal Process Cleaner: Show Tracked Processes**
- **Terminal Process Cleaner: Kill Tracked Processes**
- **Terminal Process Cleaner: Toggle Dry Run**

## Limitations

This version targets local macOS terminals. It cannot reliably clean up processes that daemonize, detach into `tmux`/`screen`, move to another session, or run in a remote terminal. It also deliberately avoids acting on terminal closes caused by non-user shutdown events.
