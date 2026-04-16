import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";

export type StoredOracleStatus = "completed" | "background" | "failed";
export type OracleContentSection = "answer" | "logs" | "metadata" | "all";

export interface StoredOracleMetadata {
  id: string;
  status: StoredOracleStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  notifiedAt?: string;
  engine: string;
  model: string;
  prompt: string;
  files: string[];
  cwd: string;
  wait: boolean;
  sessionId?: string;
  reattachCommand?: string;
  exitCode?: number;
  killed?: boolean;
  command?: string;
  args?: string[];
  oracleHomeDir?: string;
}

export interface StoredOracleRecord {
  metadata: StoredOracleMetadata;
  answer?: string;
  logs?: string;
}

export interface OracleStorePaths {
  rootDir: string;
  responseDir: string;
  metadataPath: string;
  answerPath: string;
  logsPath: string;
}

export interface OracleSessionStorePaths {
  homeDir: string;
  configPath: string;
  sessionsDir: string;
}

export function createOracleResponseId(now: Date = new Date()): string {
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ];
  return `${parts.join("")}-${randomUUID().slice(0, 8)}`;
}

export function findProjectRoot(cwd: string): string {
  const original = path.resolve(cwd);
  let current = original;

  while (true) {
    if (hasMarker(current, ".git")) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return original;
    }
    current = parent;
  }
}

export function oracleStoreRoot(cwd: string): string {
  return path.join(findProjectRoot(cwd), ".pi", "oracle");
}

export function oracleSessionStoreRoot(cwd: string): OracleSessionStorePaths {
  const homeDir = path.join(oracleStoreRoot(cwd), "oracle-home");
  return {
    homeDir,
    configPath: path.join(homeDir, "config.json"),
    sessionsDir: path.join(homeDir, "sessions"),
  };
}

export function oracleSessionDirectory(cwd: string, sessionId: string): string {
  return path.join(oracleSessionStoreRoot(cwd).sessionsDir, validateSessionId(sessionId));
}

export function oracleSessionMetadataPath(cwd: string, sessionId: string): string {
  return path.join(oracleSessionDirectory(cwd, sessionId), "meta.json");
}

export function oracleSessionLogPath(cwd: string, sessionId: string): string {
  return path.join(oracleSessionDirectory(cwd, sessionId), "output.log");
}

export async function ensureProjectOracleHome(cwd: string): Promise<OracleSessionStorePaths> {
  const paths = oracleSessionStoreRoot(cwd);
  await mkdir(paths.homeDir, { recursive: true });
  await mkdir(paths.sessionsDir, { recursive: true });

  if (!existsSync(paths.configPath)) {
    const globalConfigPath = path.join(os.homedir(), ".oracle", "config.json");
    if (existsSync(globalConfigPath)) {
      await copyFile(globalConfigPath, paths.configPath).catch(() => undefined);
    }
  }

  return paths;
}

export function oracleStorePaths(cwd: string, responseId: string): OracleStorePaths {
  const validatedId = validateResponseId(responseId);
  const rootDir = oracleStoreRoot(cwd);
  const responseDir = path.join(rootDir, validatedId);

  return {
    rootDir,
    responseDir,
    metadataPath: path.join(responseDir, "metadata.json"),
    answerPath: path.join(responseDir, "answer.md"),
    logsPath: path.join(responseDir, "logs.txt"),
  };
}

export async function writeOracleMetadata(cwd: string, metadata: StoredOracleMetadata): Promise<OracleStorePaths> {
  const normalized = normalizeMetadata(metadata);
  const paths = oracleStorePaths(cwd, normalized.id);
  await mkdir(paths.responseDir, { recursive: true });
  await writeTextAtomic(paths.metadataPath, `${JSON.stringify(normalized, null, 2)}\n`);
  return paths;
}

export async function writeOracleAnswer(cwd: string, responseId: string, answer: string | undefined): Promise<void> {
  const paths = oracleStorePaths(cwd, responseId);
  await mkdir(paths.responseDir, { recursive: true });
  await writeOptionalText(paths.answerPath, answer);
}

export async function writeOracleLogs(cwd: string, responseId: string, logs: string | undefined): Promise<void> {
  const paths = oracleStorePaths(cwd, responseId);
  await mkdir(paths.responseDir, { recursive: true });
  await writeOptionalText(paths.logsPath, logs);
}

export async function updateOracleMetadata(
  cwd: string,
  responseId: string,
  updates: Partial<StoredOracleMetadata>,
): Promise<StoredOracleMetadata> {
  const current = await readOracleMetadata(cwd, responseId);
  const next = normalizeMetadata({
    ...current,
    ...updates,
    id: current.id,
    updatedAt: updates.updatedAt ?? new Date().toISOString(),
  });
  await writeOracleMetadata(cwd, next);
  return next;
}

export async function readOracleMetadata(cwd: string, responseId: string): Promise<StoredOracleMetadata> {
  const paths = oracleStorePaths(cwd, responseId);
  const raw = await readFile(paths.metadataPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return parseMetadata(parsed);
}

export async function listPendingOracleBackgroundResults(cwd: string): Promise<StoredOracleMetadata[]> {
  const rootDir = oracleStoreRoot(cwd);
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const results: StoredOracleMetadata[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const metadata = await readOracleMetadata(cwd, entry.name);
      if (metadata.status === "background" && metadata.sessionId && !metadata.notifiedAt) {
        results.push(metadata);
      }
    } catch {
      // Ignore malformed or partially written entries while scanning the store.
    }
  }

  return results;
}

export async function readOracleRecord(cwd: string, responseId: string): Promise<StoredOracleRecord> {
  const paths = oracleStorePaths(cwd, responseId);
  const metadata = await readOracleMetadata(cwd, responseId);
  const [answer, logs] = await Promise.all([
    readOptionalText(paths.answerPath),
    readOptionalText(paths.logsPath),
  ]);

  return {
    metadata,
    answer,
    logs,
  };
}

export async function readOracleSection(cwd: string, responseId: string, section: OracleContentSection): Promise<string> {
  const record = await readOracleRecord(cwd, responseId);

  if (section === "metadata") {
    return `${JSON.stringify(record.metadata, null, 2)}\n`;
  }
  if (section === "answer") {
    return record.answer ?? "";
  }
  if (section === "logs") {
    return record.logs ?? "";
  }

  const chunks = [
    "# Metadata",
    "",
    "```json",
    JSON.stringify(record.metadata, null, 2),
    "```",
  ];

  if (record.answer !== undefined) {
    chunks.push("", "# Answer", "", record.answer);
  }
  if (record.logs !== undefined) {
    chunks.push("", "# Logs", "", "```text", record.logs, "```");
  }

  return `${chunks.join("\n").trim()}\n`;
}

function hasMarker(dir: string, marker: string): boolean {
  return existsSync(path.join(dir, marker));
}

function validateResponseId(responseId: string): string {
  const trimmed = responseId.trim();
  if (!trimmed || !/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error(`Invalid Oracle responseId: ${responseId}`);
  }
  return trimmed;
}

function validateSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed || !/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error(`Invalid Oracle session id: ${sessionId}`);
  }
  return trimmed;
}

function normalizeMetadata(metadata: StoredOracleMetadata): StoredOracleMetadata {
  return {
    ...metadata,
    id: validateResponseId(metadata.id),
    prompt: metadata.prompt.trim(),
    files: metadata.files.map((value) => value.trim()).filter(Boolean),
    command: metadata.command?.trim() || undefined,
    args: metadata.args?.map((value) => value.trim()).filter(Boolean),
    oracleHomeDir: metadata.oracleHomeDir?.trim() || undefined,
    sessionId: metadata.sessionId?.trim() || undefined,
    reattachCommand: metadata.reattachCommand?.trim() || undefined,
    completedAt: metadata.completedAt?.trim() || undefined,
    notifiedAt: metadata.notifiedAt?.trim() || undefined,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
  };
}

function parseMetadata(value: unknown): StoredOracleMetadata {
  if (!value || typeof value !== "object") {
    throw new Error("Stored Oracle metadata is not an object.");
  }

  const record = value as Record<string, unknown>;
  const status = record.status;
  if (status !== "completed" && status !== "background" && status !== "failed") {
    throw new Error("Stored Oracle metadata has an invalid status.");
  }

  return normalizeMetadata({
    id: asString(record.id, "id"),
    status,
    createdAt: asString(record.createdAt, "createdAt"),
    updatedAt: asString(record.updatedAt, "updatedAt"),
    completedAt: asOptionalString(record.completedAt),
    notifiedAt: asOptionalString(record.notifiedAt),
    engine: asString(record.engine, "engine"),
    model: asString(record.model, "model"),
    prompt: asString(record.prompt, "prompt"),
    files: asStringArray(record.files, "files"),
    cwd: asString(record.cwd, "cwd"),
    wait: asBoolean(record.wait, "wait"),
    sessionId: asOptionalString(record.sessionId),
    reattachCommand: asOptionalString(record.reattachCommand),
    exitCode: asOptionalNumber(record.exitCode),
    killed: asOptionalBoolean(record.killed),
    command: asOptionalString(record.command),
    args: asOptionalStringArray(record.args),
    oracleHomeDir: asOptionalString(record.oracleHomeDir),
  });
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Stored Oracle metadata field \"${field}\" must be a non-empty string.`);
  }
  return value;
}

function asOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("Stored Oracle metadata contains an invalid optional string field.");
  }
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Stored Oracle metadata field \"${field}\" must be a string array.`);
  }
  return value;
}

function asOptionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Stored Oracle metadata contains an invalid optional string array field.");
  }
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Stored Oracle metadata field \"${field}\" must be a boolean.`);
  }
  return value;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error("Stored Oracle metadata contains an invalid optional boolean field.");
  }
  return value;
}

function asOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error("Stored Oracle metadata contains an invalid optional number field.");
  }
  return value;
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

async function writeOptionalText(filePath: string, content: string | undefined): Promise<void> {
  if (content === undefined) {
    await rm(filePath, { force: true }).catch(() => undefined);
    return;
  }

  await writeTextAtomic(filePath, content);
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
