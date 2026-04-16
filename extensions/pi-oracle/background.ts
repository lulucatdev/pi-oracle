import { readFile } from "node:fs/promises";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  listPendingOracleBackgroundResults,
  oracleSessionLogPath,
  oracleSessionMetadataPath,
  updateOracleMetadata,
  writeOracleAnswer,
  writeOracleLogs,
  type StoredOracleStatus,
} from "./store.js";

const BACKGROUND_POLL_INTERVAL_MS = 5000;
const BACKGROUND_MONITOR_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const BACKGROUND_LOG_SETTLE_INTERVAL_MS = 200;
const BACKGROUND_LOG_SETTLE_ATTEMPTS = 10;
const activeBackgroundMonitors = new Map<string, Promise<void>>();

interface StartBackgroundMonitorParams {
  cwd: string;
  responseId: string;
  sessionId: string;
}

interface BackgroundMonitorOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

interface OracleSessionStore {
  readSession(sessionId: string): Promise<OracleSessionMetadata | null>;
  readLog(sessionId: string): Promise<string>;
}

interface OracleSessionMetadata {
  status?: string;
  completedAt?: string;
}

let oracleSessionStoreLoader: ((cwd: string) => Promise<OracleSessionStore>) | undefined;

export async function resumeOracleBackgroundMonitors(
  pi: ExtensionAPI,
  cwd: string,
  options: BackgroundMonitorOptions = {},
): Promise<void> {
  const pending = await listPendingOracleBackgroundResults(cwd);
  for (const metadata of pending) {
    if (!metadata.sessionId) {
      continue;
    }

    startOracleBackgroundMonitor(pi, {
      cwd,
      responseId: metadata.id,
      sessionId: metadata.sessionId,
    }, options);
  }
}

export function startOracleBackgroundMonitor(
  pi: ExtensionAPI,
  params: StartBackgroundMonitorParams,
  options: BackgroundMonitorOptions = {},
): void {
  if (activeBackgroundMonitors.has(params.responseId)) {
    return;
  }

  const monitor = monitorOracleBackgroundSession(pi, params, options)
    .catch((error) => {
      console.error("[pi-oracle] background monitor failed:", error);
    })
    .finally(() => {
      activeBackgroundMonitors.delete(params.responseId);
    });
  activeBackgroundMonitors.set(params.responseId, monitor);
}

export function waitForOracleBackgroundMonitor(responseId: string): Promise<void> | undefined {
  return activeBackgroundMonitors.get(responseId);
}

export function setOracleSessionStoreLoaderForTesting(
  loader: ((cwd: string) => Promise<OracleSessionStore>) | undefined,
): void {
  oracleSessionStoreLoader = loader;
}

async function monitorOracleBackgroundSession(
  pi: ExtensionAPI,
  params: StartBackgroundMonitorParams,
  options: BackgroundMonitorOptions,
): Promise<void> {
  const sessionStore = await loadOracleSessionStore(params.cwd);
  const pollIntervalMs = options.pollIntervalMs ?? BACKGROUND_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? BACKGROUND_MONITOR_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const session = await sessionStore.readSession(params.sessionId).catch(() => null);
    if (session?.status === "completed" || session?.status === "error") {
      const finalStatus: StoredOracleStatus = session.status === "completed" ? "completed" : "failed";
      const rawLog = await readSettledSessionLog(sessionStore, params.sessionId);
      const cleanedLog = stripAnsi(rawLog).trim();
      const answerText = finalStatus === "completed"
        ? (extractAnswerFromLog(cleanedLog) ?? (cleanedLog || undefined))
        : undefined;

      await writeOracleLogs(params.cwd, params.responseId, cleanedLog || undefined);
      await writeOracleAnswer(params.cwd, params.responseId, answerText);

      const metadata = await updateOracleMetadata(params.cwd, params.responseId, {
        status: finalStatus,
        completedAt: session.completedAt ?? new Date().toISOString(),
      });

      if (!metadata.notifiedAt) {
        pi.sendMessage(
          {
            customType: "oracle-background-result",
            content:
              finalStatus === "completed"
                ? `Background Oracle result ${params.responseId} is ready. Call get_oracle_content with responseId "${params.responseId}" and section "all", then summarize the Oracle answer for the user.`
                : `Background Oracle result ${params.responseId} finished with failure. Call get_oracle_content with responseId "${params.responseId}" and section "logs", then explain the failure to the user.`,
            display: true,
            details: {
              responseId: params.responseId,
              sessionId: params.sessionId,
              status: finalStatus,
            },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
        await updateOracleMetadata(params.cwd, params.responseId, {
          notifiedAt: new Date().toISOString(),
        });
      }
      return;
    }

    await sleep(pollIntervalMs);
  }

  const timedOutAt = new Date().toISOString();
  const existingLogs = await readFile(oracleSessionLogPath(params.cwd, params.sessionId), "utf8").catch(() => "");
  const cleanedExistingLogs = stripAnsi(existingLogs).trim();
  const timeoutNote = `Background Oracle monitor timed out after ${Math.round(timeoutMs / 1000)} seconds while waiting for session ${params.sessionId}.`;
  const combinedLogs = cleanedExistingLogs ? `${cleanedExistingLogs}\n\n${timeoutNote}` : timeoutNote;

  await writeOracleLogs(params.cwd, params.responseId, combinedLogs);
  const metadata = await updateOracleMetadata(params.cwd, params.responseId, {
    status: "failed",
    completedAt: timedOutAt,
  });

  if (!metadata.notifiedAt) {
    pi.sendMessage(
      {
        customType: "oracle-background-result",
        content:
          `Background Oracle result ${params.responseId} timed out before completion was detected. ` +
          `Call get_oracle_content with responseId "${params.responseId}" and section "logs", then explain the timeout to the user.`,
        display: true,
        details: {
          responseId: params.responseId,
          sessionId: params.sessionId,
          status: "failed",
        },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    await updateOracleMetadata(params.cwd, params.responseId, {
      notifiedAt: new Date().toISOString(),
    });
  }
}

async function loadOracleSessionStore(cwd: string): Promise<OracleSessionStore> {
  if (oracleSessionStoreLoader) {
    return oracleSessionStoreLoader(cwd);
  }

  return {
    async readSession(sessionId: string): Promise<OracleSessionMetadata | null> {
      const raw = await readFile(oracleSessionMetadataPath(cwd, sessionId), "utf8").catch(() => undefined);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        status: typeof parsed.status === "string" ? parsed.status : undefined,
        completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : undefined,
      };
    },
    async readLog(sessionId: string): Promise<string> {
      return readFile(oracleSessionLogPath(cwd, sessionId), "utf8");
    },
  };
}

function extractAnswerFromLog(logText: string): string | undefined {
  const marker = "Answer:";
  const index = logText.indexOf(marker);
  if (index === -1) {
    return undefined;
  }

  const answer = logText.slice(index + marker.length).trim();
  return answer || undefined;
}

function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "");
}

async function readSettledSessionLog(
  sessionStore: OracleSessionStore,
  sessionId: string,
): Promise<string> {
  let previous = "";

  for (let attempt = 0; attempt < BACKGROUND_LOG_SETTLE_ATTEMPTS; attempt += 1) {
    const current = await sessionStore.readLog(sessionId).catch(() => "");
    if (current && current === previous) {
      return current;
    }
    previous = current;
    await sleep(BACKGROUND_LOG_SETTLE_INTERVAL_MS);
  }

  return previous;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
