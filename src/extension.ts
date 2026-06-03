import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import {
  detectWaitStateCandidate,
  getLoopStopDecision,
  getWaitNotificationKind,
  getWaitStateClearDecision,
  JobInfo,
  formatDuration,
  parseFinishReason,
  parseJobInfo,
} from "./utils";
export {
  detectWaitStateCandidate,
  getLoopStopDecision,
  getWaitNotificationKind,
  getWaitStateClearDecision,
  JobInfo,
  formatDuration,
  parseFinishReason,
  parseJobInfo,
} from "./utils";

// ── Globals ───────────────────────────────────────────────────
let statusBarItem: vscode.StatusBarItem;
let pollTimer: NodeJS.Timeout | undefined;
let currentLogPath = "";
let lastByteOffset = 0;
let pendingCcreqLine = ""; // "ccreq" = Copilot Chat request line — format: "ccreq: ... | status | model | duration | [context]"
let pendingTurnCount = 0;
let pendingJobStartMs = 0;
let pendingPromptFiltered = false; // set when promptFiltered fires before the associated editAgent failed
let pendingQuestionLine = "";
let pendingQuestionSinceMs = 0;
let pendingQuestionNotified = false;
let pendingTerminalWaitLine = "";
let pendingTerminalWaitSinceMs = 0;
let pendingTerminalWaitNotified = false;
let lastFinishReason: string | undefined;
let pendingStopHookFired = false;
let isWatching = false;
let windowExtHostLogDir = ""; // set from context.logUri — unique per VS Code window
let extensionContext: vscode.ExtensionContext;

// ── Shared state (cross-window IPC) ──────────────────────────
const SHARED_STATE_FILE = "watchState.json";
const NTFY_AUTH_SECRET_KEY = "ntfyAuthorizationHeader";
const NOTIF_DEDUP_MS = 5000;
const QUESTION_NOTIFY_DELAY_MS = 60000;
const TERMINAL_WAIT_NOTIFY_DELAY_MS = 30000;
const NON_COMPLETION_NOTIFICATIONS_ENABLED = false;

type NtfyAuthMethod = "none" | "bearer" | "basic";

interface SharedStateData {
  isWatching: boolean;
  lastNotifKey?: string;
  lastNotifTs?: number;
}

function getSharedStatePath(): string {
  return path.join(extensionContext.globalStorageUri.fsPath, SHARED_STATE_FILE);
}

function readSharedStateData(): SharedStateData {
  try {
    const raw = JSON.parse(fs.readFileSync(getSharedStatePath(), "utf8"));
    if (!raw || typeof raw !== "object") {
      return { isWatching: false };
    }
    return {
      isWatching: raw.isWatching === true,
      lastNotifKey:
        typeof raw.lastNotifKey === "string" ? raw.lastNotifKey : undefined,
      lastNotifTs:
        typeof raw.lastNotifTs === "number" ? raw.lastNotifTs : undefined,
    };
  } catch {
    return { isWatching: false };
  }
}

function writeSharedStateData(data: SharedStateData): void {
  try {
    fs.mkdirSync(extensionContext.globalStorageUri.fsPath, { recursive: true });
    fs.writeFileSync(getSharedStatePath(), JSON.stringify(data), "utf8");
  } catch {
    // ignore write errors
  }
}

function readSharedIsWatching(): boolean {
  return readSharedStateData().isWatching === true;
}

function writeSharedIsWatching(value: boolean): void {
  const data = readSharedStateData();
  writeSharedStateData({ ...data, isWatching: value });
}

// ── Activation ────────────────────────────────────────────────
export async function activate(context: vscode.ExtensionContext) {
  extensionContext = context;

  // Per-window log directory: parent of this extension's log folder is the shared exthost dir
  windowExtHostLogDir = path.dirname(context.logUri.fsPath);

  // Ensure global storage directory exists (needed for shared state file)
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "copilotNtfy.startWatching";
  setStatusIdle();
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("copilotNtfy.startWatching", startWatching),
    vscode.commands.registerCommand("copilotNtfy.stopWatching", stopWatching),
    vscode.commands.registerCommand("copilotNtfy.setTopic", promptForTopic),
    vscode.commands.registerCommand("copilotNtfy.configureAuth", configureAuth),
    vscode.commands.registerCommand("copilotNtfy.testNotification", sendTestNotification),
    vscode.commands.registerCommand("copilotNtfy.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:MrCarrotLabs.copilot-ntfy")
    )
  );

  // ── Cross-window sync ──────────────────────────────────────
  // If another window is already watching, start polling immediately
  if (readSharedIsWatching()) {
    _startPolling();
  } else {
    // Auto-start based on setting
    const autoStart = getConfig().get<boolean>("autoStart", false);
    const topic = getTopic();
    if (autoStart && topic) {
      await startWatching();
    } else if (autoStart && !topic) {
      const newTopic = await promptForTopic();
      if (newTopic) {
        await startWatching();
      }
    }
  }

  // Watch the shared state file so this window reacts when another window
  // starts or stops watching (fs.watchFile uses polling — reliable cross-process)
  fs.watchFile(getSharedStatePath(), { interval: 500 }, () => {
    syncFromSharedState();
  });
}

export function deactivate() {
  // Stop watching the shared state file — do not change it;
  // other windows should continue running unaffected.
  try { fs.unwatchFile(getSharedStatePath()); } catch { /* ignore */ }
  _stopPolling();
}

// ── Status bar helpers ────────────────────────────────────────
function setStatusWatching() {
  statusBarItem.text = "Copilot Ntfy: $(eye)";
  const md = new vscode.MarkdownString(
    "**Copilot Ntfy** is active\n\n" +
    "[Stop watching](command:copilotNtfy.stopWatching) · " +
    "[Open settings](command:copilotNtfy.openSettings)"
  );
  md.isTrusted = true;
  statusBarItem.tooltip = md;
  statusBarItem.command = "copilotNtfy.stopWatching";
  statusBarItem.backgroundColor = undefined;
}

function setStatusIdle() {
  statusBarItem.text = "Copilot Ntfy: $(eye-closed)";
  const md = new vscode.MarkdownString(
    "**Copilot Ntfy** is idle\n\n" +
    "[Start watching](command:copilotNtfy.startWatching) · " +
    "[Open settings](command:copilotNtfy.openSettings)"
  );
  md.isTrusted = true;
  statusBarItem.tooltip = md;
  statusBarItem.command = "copilotNtfy.startWatching";
}

// ── Config helpers ────────────────────────────────────────────
function getConfig() {
  return vscode.workspace.getConfiguration("copilotNtfy");
}

function getTopic(): string {
  return getConfig().get<string>("ntfyTopic", "").trim();
}

function getNtfyServer(): string {
  return getConfig().get<string>("ntfyServer", "https://ntfy.sh").trim();
}

function getNtfyAuthMethod(): NtfyAuthMethod {
  const method = getConfig().get<string>("ntfyAuthMethod", "none");
  return method === "bearer" || method === "basic" ? method : "none";
}

function getPollInterval(): number {
  return getConfig().get<number>("pollIntervalMs", 5000);
}

// ── Prompt for topic ──────────────────────────────────────────
async function promptForTopic(): Promise<string | undefined> {
  const current = getTopic();
  const input = await vscode.window.showInputBox({
    title: "Copilot Ntfy — Set ntfy Topic",
    prompt: "Enter your ntfy.sh topic (e.g. my-copilot-jobs)",
    value: current,
    placeHolder: "my-copilot-jobs",
    validateInput: (v) => (v.trim() ? undefined : "Topic cannot be empty"),
  });

  if (input?.trim()) {
    await getConfig().update(
      "ntfyTopic",
      input.trim(),
      vscode.ConfigurationTarget.Global
    );
    return input.trim();
  }
  return undefined;
}

async function configureAuth(): Promise<void> {
  const currentMethod = getNtfyAuthMethod();
  const selection = await vscode.window.showQuickPick(
    [
      {
        label: "No auth",
        description: currentMethod === "none" ? "Current" : "",
        method: "none" as const,
      },
      {
        label: "Bearer token",
        description: currentMethod === "bearer" ? "Current" : "",
        method: "bearer" as const,
      },
      {
        label: "Basic auth",
        description: currentMethod === "basic" ? "Current" : "",
        method: "basic" as const,
      },
    ],
    {
      title: "Copilot Ntfy — Configure ntfy Auth",
      placeHolder: "Choose how Copilot Ntfy should authenticate to your ntfy server",
      ignoreFocusOut: true,
    }
  );

  if (!selection) return;

  if (selection.method === "none") {
    await extensionContext.secrets.delete(NTFY_AUTH_SECRET_KEY);
    await getConfig().update(
      "ntfyAuthMethod",
      "none",
      vscode.ConfigurationTarget.Global
    );
    vscode.window.showInformationMessage("Copilot Ntfy: ntfy auth cleared.");
    return;
  }

  let authorizationHeader = "";

  if (selection.method === "bearer") {
    const token = await vscode.window.showInputBox({
      title: "Copilot Ntfy — Bearer Token",
      prompt: "Enter the ntfy access token to send as a Bearer token",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim() ? undefined : "Token cannot be empty",
    });

    if (token === undefined) return;
    authorizationHeader = `Bearer ${token.trim()}`;
  }

  if (selection.method === "basic") {
    const username = await vscode.window.showInputBox({
      title: "Copilot Ntfy — Basic Auth Username",
      prompt: "Enter the username for your ntfy server",
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim() ? undefined : "Username cannot be empty",
    });

    if (username === undefined) return;

    const password = await vscode.window.showInputBox({
      title: "Copilot Ntfy — Basic Auth Password",
      prompt: "Enter the password for your ntfy server",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim() ? undefined : "Password cannot be empty",
    });

    if (password === undefined) return;

    const encoded = Buffer.from(
      `${username.trim()}:${password.trim()}`,
      "utf8"
    ).toString("base64");
    authorizationHeader = `Basic ${encoded}`;
  }

  await extensionContext.secrets.store(
    NTFY_AUTH_SECRET_KEY,
    authorizationHeader
  );
  await getConfig().update(
    "ntfyAuthMethod",
    selection.method,
    vscode.ConfigurationTarget.Global
  );
  vscode.window.showInformationMessage(
    `Copilot Ntfy: ntfy ${selection.method} auth configured.`
  );
}

async function sendTestNotification(): Promise<void> {
  const topic = getTopic();
  if (!topic) {
    const newTopic = await promptForTopic();
    if (!newTopic) {
      vscode.window.showWarningMessage(
        "Copilot Ntfy: No topic set — test notification cancelled."
      );
      return;
    }
  }

  const workspace = vscode.workspace.workspaceFolders?.[0]?.name ?? "";
  const authMethod = getNtfyAuthMethod();
  const methodLabel = authMethod === "none" ? "no auth" : authMethod;
  const msgLines = workspace
    ? [workspace, `Test notification via ${methodLabel}.`]
    : [`Test notification via ${methodLabel}.`];

  await sendNtfy(
    "Copilot Ntfy Test",
    msgLines.join("\n"),
    "default",
    "test_tube,robot"
  );

  vscode.window.showInformationMessage(
    "Copilot Ntfy: Test notification request sent."
  );
}

// ── Start / Stop (core polling, no UI side-effects) ──────────
function _startPolling() {
  isWatching = true;
  currentLogPath = "";
  lastByteOffset = 0;
  resetPendingState();
  setStatusWatching();
  if (!pollTimer) {
    pollTimer = setInterval(pollLog, getPollInterval());
  }
}

function _stopPolling() {
  isWatching = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  setStatusIdle();
}

// Triggered by fs.watchFile when another window changes the shared state file
function syncFromSharedState() {
  const newWatching = readSharedIsWatching();
  if (newWatching === isWatching) return;
  if (newWatching) {
    _startPolling();
  } else {
    _stopPolling();
  }
}

// ── Start / Stop (user-facing commands) ──────────────────────
async function startWatching() {
  if (isWatching) {
    vscode.window.showInformationMessage("Copilot Ntfy is already watching.");
    return;
  }

  // Ensure topic is set
  let topic = getTopic();
  if (!topic) {
    topic = (await promptForTopic()) ?? "";
    if (!topic) {
      vscode.window.showWarningMessage(
        "Copilot Ntfy: No topic set — watching cancelled."
      );
      return;
    }
  }

  _startPolling();
  writeSharedIsWatching(true); // broadcast to all other windows
}

function stopWatching() {
  if (!isWatching) return;
  _stopPolling();
  writeSharedIsWatching(false); // broadcast to all other windows
}

// ── Log file finder ───────────────────────────────────────────
function findLatestCopilotLog(): string {
  // Always use the Copilot Chat log that belongs to this specific VS Code window.
  // windowExtHostLogDir is derived from context.logUri which is unique per window,
  // so each window's extension instance watches only its own log.
  if (!windowExtHostLogDir) return "";
  const candidate = path.join(windowExtHostLogDir, "GitHub.copilot-chat", "GitHub Copilot Chat.log");
  return fs.existsSync(candidate) ? candidate : "";
}

// ── Poll-loop regexes (pre-compiled at module load) ──────────
const RE_SUCCESS   = /ccreq:.*\| success \|.*\[panel\/editAgent/;
const RE_WRAPPER_SUCCESS = /ccreq:.*\| success \|.*\[copilotLanguageModelWrapper\]/;
const RE_FILTERED  = /ccreq:.*\| promptFiltered \|/;
const RE_FAILED    = /ccreq:.*\| failed \|.*\[panel\/editAgent/;
const RE_TIMEOUT   = /ccreq:.*\| timeout \|.*\[panel\/editAgent/;
const RE_EMPTY     = /ccreq:.*\| empty \|.*\[panel\/editAgent/;
const RE_UNKNOWN   = /ccreq:.*\| unknown \|.*\[panel\/editAgent/;
const RE_LOOP_STOP = "[ToolCallingLoop] Stop hook result: shouldContinue=false";
const RE_AUTOPILOT_CONTINUE = "Autopilot internal stop hook: continuing";
const RE_LOOP_ERR  = /\[ToolCallingLoop\] (?:Unhandled |Runtime )?[Ee]rror:/;
const RE_AGENT_ERR = /\[editAgent\] (?:Unhandled |Runtime )?[Ee]rror:/;
const RE_ERR_MSG   = /[Ee]rror[:\s]+(.+)/;

// ── Pending state reset ─────────────────────────────────────
function resetPendingState() {
  pendingCcreqLine = "";
  pendingTurnCount = 0;
  pendingJobStartMs = 0;
  pendingPromptFiltered = false;
  pendingStopHookFired = false;
  clearPendingWaitStates();
}

function clearQuestionWaitState() {
  pendingQuestionLine = "";
  pendingQuestionSinceMs = 0;
  pendingQuestionNotified = false;
}

function clearTerminalWaitState() {
  pendingTerminalWaitLine = "";
  pendingTerminalWaitSinceMs = 0;
  pendingTerminalWaitNotified = false;
}

function clearPendingWaitStates() {
  clearQuestionWaitState();
  clearTerminalWaitState();
  lastFinishReason = undefined;
}

function startQuestionWaitState(line: string) {
  pendingQuestionLine = line;
  pendingQuestionSinceMs = Date.now();
  pendingQuestionNotified = false;
}

function startTerminalWaitState(line: string) {
  if (pendingTerminalWaitSinceMs > 0) return;
  pendingTerminalWaitLine = line;
  pendingTerminalWaitSinceMs = Date.now();
  pendingTerminalWaitNotified = false;
}

function flushPendingWaitNotifications(logSilent: boolean) {
  const now = Date.now();
  const isQuestionDue =
    pendingQuestionSinceMs > 0 &&
    !pendingQuestionNotified &&
    (logSilent || now - pendingQuestionSinceMs >= QUESTION_NOTIFY_DELAY_MS);
  const isTerminalDue =
    pendingTerminalWaitSinceMs > 0 &&
    !pendingTerminalWaitNotified &&
    (logSilent || now - pendingTerminalWaitSinceMs >= TERMINAL_WAIT_NOTIFY_DELAY_MS);
  const waitNotificationKind = getWaitNotificationKind(isQuestionDue, isTerminalDue);

  // When the log is silent (no new bytes this tick), the agent is truly idle → notify immediately.
  // The time-based thresholds serve as a backstop if the log keeps trickling minor output.
  if (waitNotificationKind === "input") {
    const jobInfo = parseJobInfo(pendingQuestionLine || pendingCcreqLine, pendingTurnCount, pendingJobStartMs);
    handleQuestionWait(jobInfo);
    pendingQuestionNotified = true;
  }

  if (waitNotificationKind === "terminal") {
    const jobInfo = parseJobInfo(pendingCcreqLine || pendingTerminalWaitLine, pendingTurnCount, pendingJobStartMs);
    handleTerminalWait(jobInfo);
    pendingTerminalWaitNotified = true;
    clearQuestionWaitState();
  }
}

// ── Poll loop ─────────────────────────────────────────────────
function pollLog() {
  const logPath = findLatestCopilotLog();
  if (!logPath) return;

  // Switched to a newer log file (new VS Code window / session)
  if (logPath !== currentLogPath) {
    currentLogPath = logPath;
    try {
      lastByteOffset = fs.statSync(logPath).size;
    } catch {
      lastByteOffset = 0;
    }
    resetPendingState();
    return;
  }

  let currentSize: number;
  try {
    currentSize = fs.statSync(logPath).size;
  } catch {
    return;
  }

  if (currentSize <= lastByteOffset) {
    flushPendingWaitNotifications(true);  // log silent — agent idle
    return;
  }

  // Read only new bytes
  let newContent = "";
  try {
    const fd = fs.openSync(logPath, "r");
    const length = currentSize - lastByteOffset;
    const buf = Buffer.alloc(length);
    try {
      fs.readSync(fd, buf, 0, length, lastByteOffset);
      newContent = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return;
  }

  lastByteOffset = currentSize;

  // Process line by line
  const lines = newContent.split("\n");
  for (const line of lines) {
    const finishReason = parseFinishReason(line);
    if (finishReason) {
      lastFinishReason = finishReason;
      const clearDecision = getWaitStateClearDecision(finishReason, pendingQuestionSinceMs > 0);
      if (clearDecision.clearQuestion) {
        clearQuestionWaitState();
      }
      if (clearDecision.clearTerminal) {
        clearTerminalWaitState();
      }
    }

    // Cache the last ccreq success line for editAgent (one LLM turn, may be many per job)
    // Matches both [panel/editAgent] and [panel/editAgent-external] (BYOK)
    if (RE_SUCCESS.test(line)) {
      const waitCandidate = detectWaitStateCandidate(line, lastFinishReason, pendingTurnCount > 0);
      if (pendingTurnCount === 0) pendingJobStartMs = Date.now();
      pendingCcreqLine = line;
      pendingTurnCount++;
      if (waitCandidate === "question") {
        startQuestionWaitState(line);
      } else {
        clearQuestionWaitState();
      }
      clearTerminalWaitState();
      lastFinishReason = undefined;
    }

    if (RE_WRAPPER_SUCCESS.test(line)) {
      const waitCandidate = detectWaitStateCandidate(line, lastFinishReason, pendingTurnCount > 0);
      if (waitCandidate === "terminal") {
        clearQuestionWaitState();
        startTerminalWaitState(line);
      }
      lastFinishReason = undefined;
    }

    // ccreq cancelled/canceled for editAgent — intentionally not handled to avoid false positives.
    // Pending state is preserved so a subsequent normal completion still has the correct context.

    // ccreq promptFiltered → content safety / RAI filter hit upstream
    // Fires in [copilotLanguageModelWrapper] context, followed by failed in editAgent.
    // We set a flag so the subsequent editAgent failed line notifies as "filtered" instead.
    if (RE_FILTERED.test(line)) {
      pendingPromptFiltered = true;
    }

    // ccreq failed for editAgent → network/API/auth error (real keyword confirmed from logs)
    // If a promptFiltered was just seen upstream, report it as filtered instead.
    if (RE_FAILED.test(line)) {
      const jobInfo = parseJobInfo(line, pendingTurnCount, pendingJobStartMs);
      const wasFiltered = pendingPromptFiltered;
      resetPendingState();
      if (wasFiltered) {
        handleJobFiltered(jobInfo);
      } else {
        handleJobFailure(jobInfo);
      }
    }

    // ccreq timeout for editAgent → backend too slow or network stalled
    if (RE_TIMEOUT.test(line)) {
      const jobInfo = parseJobInfo(line, pendingTurnCount, pendingJobStartMs);
      resetPendingState();
      handleJobTimeout(jobInfo);
    }

    // ccreq empty for editAgent → model returned 0 choices
    if (RE_EMPTY.test(line)) {
      const jobInfo = parseJobInfo(line, pendingTurnCount, pendingJobStartMs);
      resetPendingState();
      handleJobEmpty(jobInfo);
    }

    // ccreq unknown for editAgent → unexpected/unrecognised outcome
    if (RE_UNKNOWN.test(line)) {
      const jobInfo = parseJobInfo(line, pendingTurnCount, pendingJobStartMs);
      resetPendingState();
      handleJobError(jobInfo);
    }

    // ToolCallingLoop stop = agent loop wants to stop.
    // Deferred: the very next line may be an autopilot override that continues the run.
    if (line.includes(RE_LOOP_STOP)) {
      const loopStopDecision = getLoopStopDecision(
        pendingQuestionSinceMs > 0,
        pendingTerminalWaitSinceMs > 0
      );
      if (loopStopDecision.notifyCompletion && pendingTurnCount > 0) {
        pendingStopHookFired = true;
      }
    }

    // Autopilot override: the stop hook was overridden — agent is NOT done
    if (line.includes(RE_AUTOPILOT_CONTINUE)) {
      pendingStopHookFired = false;
    }

    // ToolCallingLoop/editAgent runtime error (e.g. unhandled exception in loop)
    // Regexes are intentionally narrow to avoid false positives on lines that merely mention "Error".
    if (RE_LOOP_ERR.test(line) || RE_AGENT_ERR.test(line)) {
      const errorMatch = line.match(RE_ERR_MSG);
      const reason = errorMatch ? errorMatch[1].trim() : "Unknown error";
      const jobInfo = parseJobInfo(pendingCcreqLine, pendingTurnCount, pendingJobStartMs);
      resetPendingState();
      handleJobError(jobInfo, reason);
    }
  }

  // Deferred stop-hook notification: fire only if no autopilot override was seen
  if (pendingStopHookFired) {
    const jobInfo = parseJobInfo(pendingCcreqLine, pendingTurnCount, pendingJobStartMs);
    resetPendingState();
    handleJobComplete(jobInfo);
  }

  flushPendingWaitNotifications(false);  // just processed new content
}

// ── Job outcome handlers ──────────────────────────────────────
function handleJobComplete(job: JobInfo) {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.name ?? "";
  const meta = `${job.model} · ${job.duration}`;
  const msgLines = workspace ? [workspace, meta] : [meta];
  void sendNtfy("Copilot Job Finished", msgLines.join("\n"), "default", "robot,white_check_mark");
}

function sendNonCompletionNtfy(title: string, body: string, priority = "default", tags = "robot,white_check_mark") {
  if (!NON_COMPLETION_NOTIFICATIONS_ENABLED) return;
  void sendNtfy(title, body, priority, tags);
}

function handleJobCancelled(job: JobInfo) {
  const message = `Model: ${job.model} (${job.duration})`;
  sendNonCompletionNtfy("Copilot Job Cancelled", message, "default", "robot,no_entry_sign");
}

function handleJobFailure(job: JobInfo) {
  let detail = "";
  let title = "Copilot Job Failed";
  if (job.errorCode === "429") {
    title = "Copilot Rate Limited";
    detail = "\nRate limit hit — try again in a moment.";
  } else if (job.errorCode === "401" || job.errorCode === "403") {
    title = "Copilot Auth Error";
    detail = `\nHTTP ${job.errorCode} — check your GitHub login.`;
  } else if (job.errorCode) {
    detail = `\nError: ${job.errorCode}`;
  }
  const message = `Model: ${job.model} (${job.duration})${detail}`;
  sendNonCompletionNtfy(title, message, "high", "robot,x");
}

function handleJobFiltered(job: JobInfo) {
  const message = `Model: ${job.model} (${job.duration})\nContent safety or copyright filter triggered.`;
  sendNonCompletionNtfy("Copilot Request Filtered", message, "default", "robot,warning");
}

function handleJobTimeout(job: JobInfo) {
  const code = job.errorCode ? ` (${job.errorCode})` : "";
  const message = `Model: ${job.model} (${job.duration})${code}`;
  sendNonCompletionNtfy("Copilot Job Timed Out", message, "high", "robot,hourglass_flowing_sand");
}

function handleJobEmpty(job: JobInfo) {
  const message = `Model: ${job.model} (${job.duration})\nModel returned 0 choices.`;
  sendNonCompletionNtfy("Copilot Empty Response", message, "default", "robot,question");
}

function handleJobError(job: JobInfo, reason?: string) {
  const detail = reason ? `\nReason: ${reason}` : "";
  const message = `Model: ${job.model} (${job.duration})${detail}`;
  sendNonCompletionNtfy("Copilot Job Failed", message, "high", "robot,x");
}

function handleQuestionWait(job: JobInfo) {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.name ?? "";
  const meta = `${job.model} · ${job.duration}`;
  const msgLines = workspace
    ? [workspace, "Copilot is waiting for your input.", meta]
    : ["Copilot is waiting for your input.", meta];
  sendNonCompletionNtfy("Copilot Needs Input", msgLines.join("\n"), "high", "robot,question");
}

function handleTerminalWait(job: JobInfo) {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.name ?? "";
  const meta = `${job.model} · ${job.duration}`;
  const msgLines = workspace
    ? [workspace, "Copilot needs terminal input.", meta]
    : ["Copilot needs terminal input.", meta];
  sendNonCompletionNtfy("Copilot Waiting On Terminal", msgLines.join("\n"), "high", "robot,keyboard");
}

// ── Send ntfy notification ────────────────────────────────────
async function sendNtfy(title: string, body: string, priority = "default", tags = "robot,white_check_mark") {
  const server = getNtfyServer();
  const topic = getTopic();
  if (!topic) return;

  let url: URL;
  try {
    const normalizedServer = server.endsWith("/") ? server : `${server}/`;
    url = new URL(topic.replace(/^\/+/, ""), normalizedServer);
  } catch {
    vscode.window.showWarningMessage(
      `Copilot Ntfy: Invalid ntfy server URL — "${server}". Please check your settings.`
    );
    return;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    vscode.window.showWarningMessage(
      `Copilot Ntfy: Unsupported ntfy server URL scheme — "${url.protocol}". Use http or https.`
    );
    return;
  }

  const authMethod = getNtfyAuthMethod();
  const authHeader = authMethod === "none"
    ? undefined
    : await extensionContext.secrets.get(NTFY_AUTH_SECRET_KEY);
  if (authMethod !== "none" && !authHeader) {
    vscode.window.showWarningMessage(
      "Copilot Ntfy: ntfy auth is enabled but no credentials are stored. Run 'Copilot Ntfy: Configure ntfy Auth'."
    );
    return;
  }

  // Dedup: skip if the exact same notification was already sent within NOTIF_DEDUP_MS
  // (guards against two extension instances — e.g. installed + dev host — double-firing)
  const notifKey = `${title}\x00${body}`;
  const state = readSharedStateData();
  const now = Date.now();
  if (state.lastNotifKey === notifKey && now - (state.lastNotifTs ?? 0) < NOTIF_DEDUP_MS) {
    return;
  }
  writeSharedStateData({ ...state, lastNotifKey: notifKey, lastNotifTs: now });
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;

  const bodyBuf = Buffer.from(body, "utf8");
  const headers: http.OutgoingHttpHeaders = {
    "Content-Type": "text/plain",
    "Content-Length": bodyBuf.length,
    Title: title,
    Priority: priority,
    Tags: tags,
  };

  if (authHeader) {
    headers.Authorization = authHeader;
  }

  const options: http.RequestOptions = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname,
    method: "POST",
    headers,
  };

  const req = lib.request(options, (res: http.IncomingMessage) => {
    if (res.statusCode && res.statusCode >= 400) {
      vscode.window.showWarningMessage(
        `Copilot Ntfy: ntfy returned HTTP ${res.statusCode}`
      );
    }
    res.resume(); // drain the response so the socket is freed
  });

  req.setTimeout(10000, () => {
    req.destroy(new Error("ntfy request timed out after 10s"));
  });

  req.on("error", (err: Error) => {
    vscode.window.showWarningMessage(`Copilot Ntfy: Request failed — ${err.message}`);
  });

  req.write(bodyBuf);
  req.end();
}
