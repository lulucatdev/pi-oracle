import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";

import { startOracleBackgroundMonitor } from "./background.js";
import {
  createOracleResponseId,
  ensureProjectOracleHome,
  oracleStorePaths,
  readOracleRecord,
  readOracleSection,
  writeOracleAnswer,
  writeOracleLogs,
  writeOracleMetadata,
  type StoredOracleMetadata,
  type StoredOracleRecord,
  type StoredOracleStatus,
} from "./store.js";

const DEFAULT_ENGINE = "browser" as const;
const DEFAULT_MODEL = "gpt-5.4-pro";
const DEFAULT_BROWSER_COOKIE_WAIT = "5s";
const DEFAULT_AUTO_REATTACH_DELAY = "5s";
const DEFAULT_AUTO_REATTACH_INTERVAL = "3s";
const DEFAULT_AUTO_REATTACH_TIMEOUT = "60s";
const MAX_INLINE_PREVIEW_CHARS = 4000;
const MAX_INLINE_PREVIEW_CHARS_DRY_RUN = 12000;
const oracleRequire = createRequire(import.meta.url);
const oracleRunnerPath = fileURLToPath(new URL("./run-oracle.mjs", import.meta.url));

const DISALLOWED_EXTRA_ARGS = new Set([
  "--engine",
  "--mode",
  "-e",
  "--model",
  "--models",
  "-m",
  "--prompt",
  "--message",
  "-p",
  "--file",
  "-f",
  "--include",
  "--files",
  "--path",
  "--paths",
  "--slug",
  "-s",
  "--wait",
  "--no-wait",
  "--dry-run",
  "--preview",
  "--write-output",
  "--files-report",
  "--verbose",
  "-v",
  "--background",
  "--no-background",
  "--followup",
  "--followup-model",
  "--render",
  "--render-markdown",
  "--render-plain",
  "--copy",
  "--copy-markdown",
  "--browser",
  "--browser-attachments",
  "--browser-inline-files",
  "--browser-bundle-files",
  "--browser-thinking-time",
  "--browser-keep-browser",
  "--browser-manual-login",
  "--browser-model-strategy",
  "--browser-cookie-wait",
  "--browser-auto-reattach-delay",
  "--browser-auto-reattach-interval",
  "--browser-auto-reattach-timeout",
]);
const DISALLOWED_EXTRA_ARG_PREFIXES = [...DISALLOWED_EXTRA_ARGS]
  .filter((flag) => flag.startsWith("--"))
  .map((flag) => `${flag}=`);

const oracleConsultSchema = Type.Object({
  prompt: Type.String({
    description: "The task or question to send to Oracle.",
  }),
  files: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Files, directories, or glob patterns to attach. Prefix an entry with ! to exclude it.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: `Oracle model id or browser label. Defaults to ${DEFAULT_MODEL}.`,
    }),
  ),
  engine: Type.Optional(
    Type.Union([Type.Literal("browser"), Type.Literal("api")], {
      description: `Execution engine. Defaults to ${DEFAULT_ENGINE}.`,
    }),
  ),
  slug: Type.Optional(
    Type.String({
      description: "Optional Oracle session slug.",
    }),
  ),
  wait: Type.Optional(
    Type.Boolean({
      description: "Keep the tool attached until Oracle returns a final answer. Defaults to true.",
    }),
  ),
  dryRunMode: Type.Optional(
    Type.Union([Type.Literal("summary"), Type.Literal("json"), Type.Literal("full")], {
      description: "Preview mode that avoids a real model call: summary, json, or full.",
    }),
  ),
  filesReport: Type.Optional(
    Type.Boolean({
      description: "Ask Oracle to print per-file token information.",
    }),
  ),
  browserAttachments: Type.Optional(
    Type.Union([Type.Literal("auto"), Type.Literal("never"), Type.Literal("always")], {
      description: "Browser-mode attachment strategy: auto, never, or always.",
    }),
  ),
  browserBundleFiles: Type.Optional(
    Type.Boolean({
      description: "Bundle browser uploads into a single archive before upload.",
    }),
  ),
  browserThinkingTime: Type.Optional(
    Type.Union(
      [
        Type.Literal("light"),
        Type.Literal("standard"),
        Type.Literal("extended"),
        Type.Literal("heavy"),
      ],
      {
        description: "Browser-mode thinking intensity for Thinking and Pro models.",
      },
    ),
  ),
  browserKeepBrowser: Type.Optional(
    Type.Boolean({
      description: "Keep the Chrome window open after completion.",
    }),
  ),
  browserManualLogin: Type.Optional(
    Type.Boolean({
      description: "Use Oracle's persistent manual-login browser profile instead of cookie sync.",
    }),
  ),
  browserModelStrategy: Type.Optional(
    Type.Union([Type.Literal("select"), Type.Literal("current"), Type.Literal("ignore")], {
      description: "ChatGPT model picker strategy: select, current, or ignore.",
    }),
  ),
  browserCookieWait: Type.Optional(
    Type.String({
      description:
        "Browser-mode cookie sync grace period before Oracle gives up on Chrome cookie reuse. Defaults to 5s.",
    }),
  ),
  verbose: Type.Optional(
    Type.Boolean({
      description: "Enable verbose Oracle logging.",
    }),
  ),
  extraArgs: Type.Optional(
    Type.Array(Type.String(), {
      description: "Additional raw Oracle CLI arguments for advanced cases.",
    }),
  ),
});

const getOracleContentSchema = Type.Object({
  responseId: Type.String({
    description: "The stored Oracle response id returned by oracle_consult.",
  }),
  section: Type.Optional(
    Type.Union([
      Type.Literal("answer"),
      Type.Literal("logs"),
      Type.Literal("metadata"),
      Type.Literal("all"),
    ], {
      description: "Which stored section to retrieve: answer, logs, metadata, or all. Defaults to all.",
    }),
  ),
});

type OracleConsultParams = Static<typeof oracleConsultSchema>;
type GetOracleContentParams = Static<typeof getOracleContentSchema>;
type OracleRunStatus = StoredOracleStatus | "dry-run";

interface OracleCommand {
  command: string;
  cliPath: string;
  source: string;
}

interface PersistedOracleResult {
  responseId: string;
  storedSections: string[];
  storeDir: string;
}

function resolveOracleCommand(): OracleCommand {
  try {
    const bundledCli = oracleRequire.resolve("@steipete/oracle/dist/bin/oracle-cli.js");
    return {
      command: process.execPath,
      cliPath: bundledCli,
      source: "package dependency",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Bundled @steipete/oracle CLI not found. Reinstall the package dependencies before using oracle_consult. (${message})`,
    );
  }
}

function validateExtraArgs(extraArgs: string[] | undefined): string[] {
  const normalized = (extraArgs ?? []).map((value) => value.trim()).filter(Boolean);
  const blocked = normalized.filter(
    (value) =>
      DISALLOWED_EXTRA_ARGS.has(value) ||
      DISALLOWED_EXTRA_ARG_PREFIXES.some((prefix) => value.startsWith(prefix)),
  );

  if (blocked.length > 0) {
    throw new Error(
      `extraArgs may not override wrapper-managed flags: ${blocked.join(", ")}. Use the structured tool parameters instead.`,
    );
  }

  return normalized;
}

function normalizeFileInputs(files: string[] | undefined): string[] {
  return (files ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      if (!value.startsWith("@")) {
        return value;
      }

      const remainder = value.slice(1);
      if (
        remainder.startsWith("/") ||
        remainder.startsWith("./") ||
        remainder.startsWith("../") ||
        remainder.startsWith("~/") ||
        remainder.startsWith("*")
      ) {
        return remainder;
      }

      return value;
    });
}

function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "");
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  return {
    text: `${text.slice(0, maxChars)}\n\n[truncated after ${maxChars} characters]`,
    truncated: true,
  };
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}

function buildOracleReattachCommand(sessionId: string, oracleHomeDir: string): string {
  return `env ORACLE_HOME_DIR=${shellQuote(oracleHomeDir)} oracle session ${sessionId}`;
}

function extractSessionId(text: string): string | undefined {
  const cleaned = stripAnsi(text);
  const matches = [...cleaned.matchAll(/oracle session\s+([^\s]+)/g)];
  return matches.at(-1)?.[1];
}

function buildOracleArgs(params: OracleConsultParams, outputPath: string): string[] {
  const engine = params.engine ?? DEFAULT_ENGINE;
  const model = params.model?.trim() || DEFAULT_MODEL;
  const files = normalizeFileInputs(params.files);
  const extraArgs = validateExtraArgs(params.extraArgs);
  const wait = params.wait ?? true;
  const args: string[] = ["--engine", engine, "--model", model, "--prompt", params.prompt.trim()];

  if (params.slug?.trim()) {
    args.push("--slug", params.slug.trim());
  }

  for (const file of files) {
    args.push("--file", file);
  }

  if (params.filesReport) {
    args.push("--files-report");
  }

  if (params.verbose) {
    args.push("--verbose");
  }

  if (params.dryRunMode) {
    args.push("--dry-run", params.dryRunMode);
  } else if (wait) {
    args.push("--write-output", outputPath);
  }

  if (wait) {
    args.push("--wait");
  } else {
    args.push("--no-wait");
  }

  if (engine === "browser") {
    const browserCookieWait = params.browserCookieWait?.trim() || DEFAULT_BROWSER_COOKIE_WAIT;
    args.push(
      "--browser-cookie-wait",
      browserCookieWait,
      "--browser-auto-reattach-delay",
      DEFAULT_AUTO_REATTACH_DELAY,
      "--browser-auto-reattach-interval",
      DEFAULT_AUTO_REATTACH_INTERVAL,
      "--browser-auto-reattach-timeout",
      DEFAULT_AUTO_REATTACH_TIMEOUT,
    );

    if (params.browserAttachments) {
      args.push("--browser-attachments", params.browserAttachments);
    }
    if (params.browserBundleFiles) {
      args.push("--browser-bundle-files");
    }
    if (params.browserThinkingTime) {
      args.push("--browser-thinking-time", params.browserThinkingTime);
    }
    if (params.browserKeepBrowser) {
      args.push("--browser-keep-browser");
    }
    if (params.browserManualLogin) {
      args.push("--browser-manual-login");
    }
    if (params.browserModelStrategy) {
      args.push("--browser-model-strategy", params.browserModelStrategy);
    }
  }

  if (extraArgs.length > 0) {
    args.push(...extraArgs);
  }

  return args;
}

function inlinePreviewLabel(status: OracleRunStatus, previewRequested: boolean): string {
  if (status === "dry-run") {
    return "Oracle preview";
  }
  if (status === "background") {
    return "Oracle startup preview";
  }
  if (status === "failed") {
    return previewRequested ? "Oracle preview logs" : "Oracle failure preview";
  }
  return "Oracle answer preview";
}

function formatInlineResultContent(input: {
  responseId?: string;
  previewText: string;
  sessionId?: string;
  engine: string;
  model: string;
  dryRunMode?: string;
  wait: boolean;
  truncated: boolean;
  exitCode?: number;
  previewRequested: boolean;
  status: OracleRunStatus;
  storedSections?: string[];
}): string {
  const heading =
    input.status === "failed" && input.previewRequested
      ? `Oracle dry run failed (${input.dryRunMode}).`
      : input.status === "dry-run"
        ? `Oracle dry run completed (${input.dryRunMode}).`
        : input.status === "background"
          ? "Oracle consultation started in background."
          : input.status === "failed"
            ? "Oracle consultation failed."
            : "Oracle consultation completed.";

  const lines = [
    heading,
    `Engine: ${input.engine}`,
    `Model: ${input.model}`,
    `Wait: ${input.wait ? "attached" : "detached"}`,
  ];

  if (input.responseId) {
    lines.push(`Response ID: ${input.responseId}`);
  }
  if (input.sessionId) {
    lines.push(`Session: ${input.sessionId}`);
  }
  if (typeof input.exitCode === "number") {
    lines.push(`Exit code: ${input.exitCode}`);
  }
  if (input.storedSections && input.storedSections.length > 0) {
    lines.push(`Stored sections: ${input.storedSections.join(", ")}`);
  }
  if (input.truncated) {
    lines.push("Note: only a compact preview was inserted into the tool result.");
  }

  return `${lines.join("\n")}\n\n${inlinePreviewLabel(input.status, input.previewRequested)}:\n\n${input.previewText}`.trim();
}

function availableSections(record: StoredOracleRecord): string[] {
  const sections = ["metadata"];
  if (record.answer !== undefined) {
    sections.push("answer");
  }
  if (record.logs !== undefined) {
    sections.push("logs");
  }
  return sections;
}

async function persistOracleResult(input: {
  cwd: string;
  prompt: string;
  files: string[];
  wait: boolean;
  engine: string;
  model: string;
  status: StoredOracleStatus;
  sessionId?: string;
  exitCode?: number;
  killed?: boolean;
  command: string;
  args: string[];
  oracleHomeDir: string;
  answer?: string;
  logs?: string;
}): Promise<PersistedOracleResult> {
  const responseId = createOracleResponseId();
  const now = new Date().toISOString();
  const metadata: StoredOracleMetadata = {
    id: responseId,
    status: input.status,
    createdAt: now,
    updatedAt: now,
    completedAt: input.status === "background" ? undefined : now,
    engine: input.engine,
    model: input.model,
    prompt: input.prompt,
    files: input.files,
    cwd: input.cwd,
    wait: input.wait,
    sessionId: input.sessionId,
    reattachCommand: input.sessionId
      ? buildOracleReattachCommand(input.sessionId, input.oracleHomeDir)
      : undefined,
    exitCode: input.exitCode,
    killed: input.killed,
    command: input.command,
    args: input.args,
    oracleHomeDir: input.oracleHomeDir,
  };

  const paths = await writeOracleMetadata(input.cwd, metadata);
  await writeOracleAnswer(input.cwd, responseId, input.answer);
  await writeOracleLogs(input.cwd, responseId, input.logs);

  const storedSections = ["metadata"];
  if (input.answer !== undefined) {
    storedSections.push("answer");
  }
  if (input.logs !== undefined) {
    storedSections.push("logs");
  }

  return {
    responseId,
    storedSections,
    storeDir: paths.responseDir,
  };
}

export default function piOracle(pi: ExtensionAPI) {
  pi.registerTool({
    name: "get_oracle_content",
    label: "Get Oracle Content",
    description: "Retrieve stored Oracle result content by response id.",
    promptSnippet:
      "Use after oracle_consult when a stored Oracle responseId must be expanded into full answer, logs, metadata, or all sections.",
    parameters: getOracleContentSchema,

    async execute(_toolCallId, params: GetOracleContentParams, _signal, _onUpdate, ctx) {
      const section = params.section ?? "all";

      let record: StoredOracleRecord;
      try {
        record = await readOracleRecord(ctx.cwd, params.responseId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Stored Oracle result not found for responseId ${params.responseId}. ${message}`);
      }

      const sections = availableSections(record);
      if (section !== "all" && !sections.includes(section)) {
        throw new Error(
          `Stored Oracle section \"${section}\" is not available for responseId ${params.responseId}. Available sections: ${sections.join(", ")}.`,
        );
      }

      const contentText = await readOracleSection(ctx.cwd, params.responseId, section);
      return {
        content: [{ type: "text", text: contentText }],
        details: {
          responseId: record.metadata.id,
          section,
          availableSections: sections,
          status: record.metadata.status,
          storeDir: oracleStorePaths(ctx.cwd, record.metadata.id).responseDir,
        },
      };
    },
  });

  pi.registerTool({
    name: "oracle_consult",
    label: "Oracle Consult",
    description:
      "Run an explicit Oracle consultation through @steipete/oracle. Use only when the user explicitly asks to consult Oracle or asks for an external second-model review.",
    promptSnippet:
      "Consult Oracle, an external model wrapper around ChatGPT or API models, for explicit second-opinion reviews with selected files.",
    promptGuidelines: [
      "Use `oracle_consult` only when the user explicitly asks for Oracle, an external second opinion, or invokes `/oracle`.",
      "Before calling `oracle_consult`, gather the minimal relevant files and pass them via the `files` array.",
      `Default to engine \`${DEFAULT_ENGINE}\`, model \`${DEFAULT_MODEL}\`, and \`wait: true\` unless the user requests different Oracle behavior.`,
    ],
    parameters: oracleConsultSchema,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const resolvedPrompt = params.prompt.trim();
      if (!resolvedPrompt) {
        throw new Error("Oracle invocation failed. Prompt is empty.");
      }

      const engine = params.engine ?? DEFAULT_ENGINE;
      const model = params.model?.trim() || DEFAULT_MODEL;
      const wait = params.wait ?? true;
      const previewRequested = params.dryRunMode !== undefined;
      const normalizedFiles = normalizeFileInputs(params.files);
      if (engine === "browser" && !wait) {
        throw new Error(
          "Oracle invocation failed. Detached browser mode is not supported by Oracle. Use wait: true or engine: \"api\".",
        );
      }
      let tempDir: string | undefined;

      try {
        const oracle = resolveOracleCommand();
        const oracleHome = await ensureProjectOracleHome(ctx.cwd);
        tempDir = await mkdtemp(path.join(tmpdir(), "pi-oracle-"));
        const outputPath = path.join(tempDir, "oracle-output.md");
        const oracleArgs = buildOracleArgs(params, outputPath);
        const args = [oracle.cliPath, ...oracleArgs];
        const execArgs = [oracleRunnerPath, oracleHome.homeDir, ...args];

        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Launching Oracle via ${oracle.source} (${engine}, ${model}).`,
            },
          ],
          details: {
            command: oracle.command,
            args,
            cwd: ctx.cwd,
            oracleHomeDir: oracleHome.homeDir,
          },
        });

        const result = await pi.exec(oracle.command, execArgs, { signal, cwd: ctx.cwd });
        const stdout = result.stdout ?? "";
        const stderr = result.stderr ?? "";
        const sessionId = extractSessionId(`${stdout}\n${stderr}`);
        const outputText = await readFile(outputPath, "utf8").catch(() => "");
        const cleanedLogs = stripAnsi(`${stdout}\n${stderr}`).trim();

        const status: OracleRunStatus = result.code !== 0
          ? "failed"
          : previewRequested
            ? "dry-run"
            : wait
              ? "completed"
              : "background";

        const answerText = outputText.trim() || cleanedLogs || "(Oracle produced no textual output.)";
        const logText = cleanedLogs || undefined;
        const previewSource =
          status === "dry-run"
            ? cleanedLogs || "(Oracle produced no preview output.)"
            : status === "background"
              ? cleanedLogs ||
                (sessionId
                  ? `Oracle is running in the background. Reattach with: ${buildOracleReattachCommand(sessionId, oracleHome.homeDir)}`
                  : "Oracle started in background mode without additional logs.")
              : status === "failed"
                ? cleanedLogs || outputText || "(Oracle exited without textual logs.)"
                : answerText;
        const maxPreviewChars = previewRequested
          ? MAX_INLINE_PREVIEW_CHARS_DRY_RUN
          : MAX_INLINE_PREVIEW_CHARS;
        const clipped = truncateText(previewSource.trim(), maxPreviewChars);

        let persisted: PersistedOracleResult | undefined;
        if (status !== "dry-run") {
          persisted = await persistOracleResult({
            cwd: ctx.cwd,
            prompt: resolvedPrompt,
            files: normalizedFiles,
            wait,
            engine,
            model,
            status,
            sessionId,
            exitCode: result.code,
            killed: result.killed,
            command: oracle.command,
            args,
            oracleHomeDir: oracleHome.homeDir,
            answer: status === "completed" ? answerText : undefined,
            logs: status === "completed" ? logText : previewSource.trim(),
          });
        }

        if (status === "background" && persisted && sessionId) {
          startOracleBackgroundMonitor(pi, {
            cwd: ctx.cwd,
            responseId: persisted.responseId,
            sessionId,
          });
        }

        const contentText = formatInlineResultContent({
          responseId: persisted?.responseId,
          previewText: clipped.text,
          sessionId,
          engine,
          model,
          dryRunMode: params.dryRunMode,
          wait,
          truncated: clipped.truncated,
          exitCode: result.code,
          previewRequested,
          status,
          storedSections: persisted?.storedSections,
        });

        return {
          content: [{ type: "text", text: contentText }],
          details: {
            command: oracle.command,
            args,
            cwd: ctx.cwd,
            sessionId,
            engine,
            model,
            wait,
            dryRunMode: params.dryRunMode,
            responseId: persisted?.responseId,
            storeDir: persisted?.storeDir ?? (persisted ? oracleStorePaths(ctx.cwd, persisted.responseId).responseDir : undefined),
            oracleHomeDir: oracleHome.homeDir,
            storedSections: persisted?.storedSections,
            finalAnswerAvailable: status === "completed" || status === "dry-run",
            reattachCommand: sessionId
              ? buildOracleReattachCommand(sessionId, oracleHome.homeDir)
              : undefined,
            previewRequested,
            truncatedInContent: clipped.truncated,
            exitCode: result.code,
            killed: result.killed,
            status,
            error: status === "failed",
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Oracle invocation failed. ${message}`);
      } finally {
        if (tempDir) {
          await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    },
  });
}
