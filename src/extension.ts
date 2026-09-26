import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface ProcessInfo {
  pid: number;
  parentPid: number;
  processGroupId: number;
  command: string;
}

interface TrackedProcess extends ProcessInfo {
  firstSeenAt: number;
}

interface TrackedTerminal {
  terminal: vscode.Terminal;
  processId?: number;
  processes: Map<number, TrackedProcess>;
  pollTimer?: NodeJS.Timeout;
  polling: boolean;
}

type LogLevel = 'off' | 'info' | 'verbose';
type KillSignal = 'SIGTERM' | 'SIGINT';

const trackedTerminals = new Map<vscode.Terminal, TrackedTerminal>();
let output: vscode.OutputChannel | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let unsupportedPlatformWarningShown = false;

function configuration() {
  return vscode.workspace.getConfiguration('terminalProcessCleaner');
}

function setting<T>(key: string, fallback: T): T {
  return configuration().get<T>(key, fallback);
}

function log(message: string, level: Exclude<LogLevel, 'off'> = 'info'): void {
  const configuredLevel = setting<LogLevel>('logLevel', 'info');
  if (configuredLevel === 'off') {
    return;
  }
  if (level === 'verbose' && configuredLevel !== 'verbose') {
    return;
  }
  output?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function executableName(command: string): string {
  const firstToken = command.trim().split(/\s+/, 1)[0] ?? '';
  const withoutOptions = firstToken.replace(/^[-]+/, '');
  const lastSlash = withoutOptions.lastIndexOf('/');
  return (lastSlash >= 0 ? withoutOptions.slice(lastSlash + 1) : withoutOptions).toLowerCase();
}

function isExcluded(processInfo: ProcessInfo): boolean {
  const excludedNames = setting<string[]>('excludeProcessNames', []);
  const excludedCommands = setting<string[]>('excludeCommands', []);
  const name = executableName(processInfo.command);
  const command = processInfo.command.toLowerCase();

  return excludedNames.some((excluded) => name === excluded.trim().toLowerCase())
    || excludedCommands.some((excluded) => command.includes(excluded.trim().toLowerCase()));
}

async function readProcessTable(): Promise<ProcessInfo[]> {
  if (process.platform !== 'darwin') {
    return [];
  }

  try {
    const result = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,command='], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const processes: ProcessInfo[] = [];

    for (const line of result.stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) {
        continue;
      }
      processes.push({
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        processGroupId: Number(match[3]),
        command: match[4],
      });
    }

    return processes;
  } catch (error) {
    log(`Could not read the macOS process table: ${String(error)}`);
    return [];
  }
}

function descendantsOf(rootPid: number, processes: ProcessInfo[]): ProcessInfo[] {
  const childrenByParent = new Map<number, ProcessInfo[]>();
  for (const processInfo of processes) {
    const children = childrenByParent.get(processInfo.parentPid) ?? [];
    children.push(processInfo);
    childrenByParent.set(processInfo.parentPid, children);
  }

  const descendants: ProcessInfo[] = [];
  const pending = [...(childrenByParent.get(rootPid) ?? [])];
  const visited = new Set<number>();

  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || visited.has(current.pid)) {
      continue;
    }
    visited.add(current.pid);
    descendants.push(current);
    pending.push(...(childrenByParent.get(current.pid) ?? []));
  }

  return descendants;
}

function sameExecutable(previous: ProcessInfo, current: ProcessInfo): boolean {
  return executableName(previous.command) === executableName(current.command);
}

async function refreshTrackedProcesses(tracked: TrackedTerminal): Promise<void> {
  if (!tracked.processId || !setting<boolean>('enabled', true)) {
    return;
  }

  const processTable = await readProcessTable();
  const descendants = descendantsOf(tracked.processId, processTable);
  const now = Date.now();

  for (const processInfo of descendants) {
    if (!isExcluded(processInfo)) {
      const existing = tracked.processes.get(processInfo.pid);
      tracked.processes.set(processInfo.pid, {
        ...processInfo,
        firstSeenAt: existing?.firstSeenAt ?? now,
      });
    }
  }

  log(
    `${tracked.terminal.name}: tracking ${tracked.processes.size} process(es) below PID ${tracked.processId}`,
    'verbose',
  );
}

function stopPolling(tracked: TrackedTerminal): void {
  if (tracked.pollTimer) {
    clearInterval(tracked.pollTimer);
    tracked.pollTimer = undefined;
  }
  tracked.polling = false;
}

function startPolling(tracked: TrackedTerminal): void {
  stopPolling(tracked);
  if (!setting<boolean>('enabled', true) || process.platform !== 'darwin') {
    return;
  }

  tracked.polling = true;
  void refreshTrackedProcesses(tracked);
  tracked.pollTimer = setInterval(() => {
    void refreshTrackedProcesses(tracked);
  }, setting<number>('pollIntervalMs', 500));
}

async function sendSignal(processInfo: ProcessInfo, signal: NodeJS.Signals): Promise<boolean> {
  try {
    process.kill(processInfo.pid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      log(`Could not send ${signal} to PID ${processInfo.pid} (${processInfo.command}): ${String(error)}`);
    }
    return false;
  }
}

async function cleanUpProcesses(tracked: TrackedTerminal, reason: string): Promise<void> {
  stopPolling(tracked);

  if (!setting<boolean>('enabled', true) || tracked.processes.size === 0) {
    log(`${tracked.terminal.name}: nothing to clean up (${reason})`, 'verbose');
    return;
  }

  const processTable = await readProcessTable();
  const currentByPid = new Map(processTable.map((processInfo) => [processInfo.pid, processInfo]));
  const candidates = [...tracked.processes.values()]
    .map((previous) => ({ previous, current: currentByPid.get(previous.pid) }))
    .filter((item): item is { previous: TrackedProcess; current: ProcessInfo } => Boolean(item.current))
    .filter((item) => sameExecutable(item.previous, item.current))
    .filter((item) => !isExcluded(item.current));

  if (candidates.length === 0) {
    log(`${tracked.terminal.name}: tracked processes already exited or changed`, 'verbose');
    return;
  }

  const dryRun = setting<boolean>('dryRun', false);
  const signal = setting<KillSignal>('killSignal', 'SIGTERM');
  const label = candidates.map(({ current }) => `PID ${current.pid} (${current.command})`).join(', ');
  log(`${tracked.terminal.name}: ${dryRun ? 'would signal' : 'signaling'} ${label}`);

  let signaled = 0;
  if (!dryRun) {
    for (const { current } of candidates) {
      if (await sendSignal(current, signal)) {
        signaled += 1;
      }
    }
  }

  const gracePeriodMs = setting<number>('gracePeriodMs', 1500);
  if (!dryRun && setting<boolean>('forceKillAfterGrace', true) && gracePeriodMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, gracePeriodMs));
    const remainingTable = await readProcessTable();
    const remainingByPid = new Map(remainingTable.map((processInfo) => [processInfo.pid, processInfo]));
    for (const { previous } of candidates) {
      const remaining = remainingByPid.get(previous.pid);
      if (remaining && sameExecutable(previous, remaining) && !isExcluded(remaining)) {
        await sendSignal(remaining, 'SIGKILL');
      }
    }
  }

  const mode = dryRun ? 'would clean up' : `cleaned up ${signaled}`;
  log(`${tracked.terminal.name}: ${mode} process(es)`);
  if (setting<boolean>('showNotifications', true)) {
    const suffix = dryRun ? ' (dry run)' : '';
    void vscode.window.showInformationMessage(
      `Terminal Process Cleaner: ${dryRun ? 'would clean up' : 'cleaned up'} ${candidates.length} process(es) from “${tracked.terminal.name}”${suffix}.`,
    );
  }
}

async function trackTerminal(terminal: vscode.Terminal): Promise<void> {
  if (trackedTerminals.has(terminal)) {
    return;
  }

  const tracked: TrackedTerminal = {
    terminal,
    processes: new Map(),
    polling: false,
  };
  trackedTerminals.set(terminal, tracked);

  try {
    tracked.processId = await terminal.processId;
    log(`${terminal.name}: attached to shell PID ${tracked.processId}`, 'verbose');
  } catch (error) {
    log(`${terminal.name}: could not obtain its process ID: ${String(error)}`);
  }

  if (trackedTerminals.has(terminal)) {
    startPolling(tracked);
  }
}

async function handleTerminalClosed(terminal: vscode.Terminal): Promise<void> {
  const tracked = trackedTerminals.get(terminal);
  if (!tracked) {
    return;
  }
  trackedTerminals.delete(terminal);

  const exitReason = terminal.exitStatus?.reason;
  if (exitReason !== vscode.TerminalExitReason.User) {
    stopPolling(tracked);
    log(`${terminal.name}: not cleaning up because the terminal did not close by user action`, 'verbose');
    return;
  }

  await cleanUpProcesses(tracked, 'user closed terminal');
}

async function showTrackedProcesses(): Promise<void> {
  const items = [...trackedTerminals.values()].flatMap((tracked) => {
    const processes = [...tracked.processes.values()];
    if (processes.length === 0) {
      return [{ label: `${tracked.terminal.name}: no descendants tracked`, description: `shell PID ${tracked.processId ?? 'unknown'}` }];
    }
    return processes.map((processInfo) => ({
      label: `${tracked.terminal.name}: PID ${processInfo.pid}`,
      description: processInfo.command,
    }));
  });

  if (items.length === 0) {
    void vscode.window.showInformationMessage('Terminal Process Cleaner is not tracking any terminals yet.');
    return;
  }

  await vscode.window.showQuickPick(items, { title: 'Terminal Process Cleaner: Tracked Processes' });
}

async function killTrackedProcesses(): Promise<void> {
  const activeTerminal = vscode.window.activeTerminal;
  const tracked = activeTerminal ? trackedTerminals.get(activeTerminal) : undefined;
  if (!tracked) {
    void vscode.window.showInformationMessage('The active terminal is not being tracked.');
    return;
  }
  await cleanUpProcesses(tracked, 'manual command');
}

async function toggleDryRun(): Promise<void> {
  const nextValue = !setting<boolean>('dryRun', false);
  await configuration().update('dryRun', nextValue, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(`Terminal Process Cleaner dry run ${nextValue ? 'enabled' : 'disabled'}.`);
}

function restartPolling(): void {
  for (const tracked of trackedTerminals.values()) {
    startPolling(tracked);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  output = vscode.window.createOutputChannel('Terminal Process Cleaner');
  context.subscriptions.push(output);

  if (process.platform !== 'darwin') {
    if (!unsupportedPlatformWarningShown) {
      unsupportedPlatformWarningShown = true;
      void vscode.window.showWarningMessage('Terminal Tab Process Cleaner currently supports macOS only.');
    }
    return;
  }

  log('Extension activated.');
  for (const terminal of vscode.window.terminals) {
    void trackTerminal(terminal);
  }

  context.subscriptions.push(
    vscode.window.onDidOpenTerminal((terminal) => {
      void trackTerminal(terminal);
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      void handleTerminalClosed(terminal);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('terminalProcessCleaner')) {
        restartPolling();
      }
    }),
    vscode.commands.registerCommand('terminalProcessCleaner.showTrackedProcesses', () => showTrackedProcesses()),
    vscode.commands.registerCommand('terminalProcessCleaner.killTrackedProcesses', () => killTrackedProcesses()),
    vscode.commands.registerCommand('terminalProcessCleaner.toggleDryRun', () => toggleDryRun()),
  );
}

export function deactivate(): void {
  for (const tracked of trackedTerminals.values()) {
    stopPolling(tracked);
  }
  trackedTerminals.clear();
  extensionContext = undefined;
  output = undefined;
}
