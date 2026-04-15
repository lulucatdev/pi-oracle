import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";

const DEFAULT_ENGINE = "browser" as const;
const DEFAULT_MODEL = "gpt-5.4-pro";
const DEFAULT_AUTO_REATTACH_DELAY = "5s";
const DEFAULT_AUTO_REATTACH_INTERVAL = "3s";
const DEFAULT_AUTO_REATTACH_TIMEOUT = "60s";
const MAX_CONTENT_CHARS = 24000;
const oracleRequire = createRequire(import.meta.url);

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

type OracleConsultParams = Static<typeof oracleConsultSchema>;

interface OracleCommand {
  command: string;
  argsPrefix: string[];
  source: string;
}

function resolveOracleCommand(): OracleCommand {
  try {
    const bundledCli = oracleRequire.resolve("@steipete/oracle/dist/bin/oracle-cli.js");
    return {
      command: process.execPath,
      argsPrefix: [bundledCli],
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

function truncateForContext(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_CONTENT_CHARS) {
    return { text, truncated: false };
  }

  return {
    text: `${text.slice(0, MAX_CONTENT_CHARS)}\n\n[truncated after ${MAX_CONTENT_CHARS} characters]`,
    truncated: true,
  };
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
    args.push(
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

function formatResultContent(input: {
  bodyText: string;
  sessionId?: string;
  engine: string;
  model: string;
  dryRunMode?: string;
  wait: boolean;
  truncated: boolean;
  exitCode?: number;
  previewRequested: boolean;
  status: "completed" | "background" | "failed" | "dry-run";
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

  if (input.sessionId) {
    lines.push(`Session: ${input.sessionId}`);
  }
  if (typeof input.exitCode === "number") {
    lines.push(`Exit code: ${input.exitCode}`);
  }
  if (input.status === "background" && input.sessionId) {
    lines.push(`Reattach with: oracle session ${input.sessionId}`);
  }
  if (input.truncated) {
    lines.push("Note: the Oracle output was truncated before it was inserted into the tool result.");
  }

  const bodyLabel =
    input.status === "failed" && input.previewRequested
      ? "Oracle preview logs"
      : input.status === "dry-run"
      ? "Oracle preview"
      : input.status === "background"
        ? "Oracle startup logs"
        : input.status === "failed"
          ? "Oracle logs"
          : "Oracle answer";
  return `${lines.join("\n")}\n\n${bodyLabel}:\n\n${input.bodyText}`.trim();
}

export default function piOracle(pi: ExtensionAPI) {
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
      let tempDir: string | undefined;

      try {
        const oracle = resolveOracleCommand();
        tempDir = await mkdtemp(path.join(tmpdir(), "pi-oracle-"));
        const outputPath = path.join(tempDir, "oracle-output.md");
        const args = [...oracle.argsPrefix, ...buildOracleArgs(params, outputPath)];

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
          },
        });

        const result = await pi.exec(oracle.command, args, { signal, cwd: ctx.cwd });
        const stdout = result.stdout ?? "";
        const stderr = result.stderr ?? "";
        const sessionId = extractSessionId(`${stdout}\n${stderr}`);
        const outputText = await readFile(outputPath, "utf8").catch(() => "");
        const cleanedLogs = stripAnsi(`${stdout}\n${stderr}`).trim();

        const status = result.code !== 0
            ? "failed"
            : previewRequested
              ? "dry-run"
              : wait
              ? "completed"
              : "background";

        const bodyText =
          status === "dry-run"
            ? cleanedLogs || "(Oracle produced no preview output.)"
            : status === "failed"
              ? cleanedLogs || outputText || "(Oracle exited without textual logs.)"
              : status === "background"
                ? cleanedLogs ||
                  (sessionId
                    ? `Oracle is running in the background. Reattach with: oracle session ${sessionId}`
                    : "Oracle started in background mode without additional logs.")
                : outputText || cleanedLogs || "(Oracle produced no textual output.)";

        const clipped = truncateForContext(bodyText.trim());
        const contentText = formatResultContent({
          bodyText: clipped.text,
          sessionId,
          engine,
          model,
          dryRunMode: params.dryRunMode,
          wait,
          truncated: clipped.truncated,
          exitCode: result.code,
          previewRequested,
          status,
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
            stdout,
            stderr,
            fullAnswer: bodyText,
            finalAnswerAvailable: status === "completed" || status === "dry-run",
            reattachCommand: sessionId ? `oracle session ${sessionId}` : undefined,
            previewRequested,
            truncatedInContent: clipped.truncated,
            exitCode: result.code,
            killed: result.killed,
            status,
          },
          isError: result.code !== 0,
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
