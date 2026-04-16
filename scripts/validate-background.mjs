import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const extensionPath = path.join(repoRoot, "extensions", "pi-oracle", "index.ts");
const tscCli = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");

function runPiJson(prompt) {
  const result = spawnSync(
    "pi",
    [
      "--mode",
      "json",
      "-ne",
      "-ns",
      "-np",
      "-e",
      extensionPath,
      "-p",
      prompt,
      "--no-session",
      "--thinking",
      "off",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    throw new Error(`pi exited with code ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }

  return result.stdout;
}

function parseJsonLines(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

const guardPrompt = [
  'Call oracle_consult exactly once with prompt "validate background guard",',
  'files ["README.md"], engine "browser", model "gpt-5.4-pro", wait false.',
  'Then stop.',
].join(" ");
const guardEvents = parseJsonLines(runPiJson(guardPrompt));
const guardResult = guardEvents.find((event) => event.type === "tool_execution_end" && event.toolName === "oracle_consult");
if (!guardResult || guardResult.isError !== true) {
  throw new Error("Expected detached browser guard to fail with a tool error.");
}
const guardText = guardResult.result?.content?.[0]?.text ?? "";
if (!guardText.includes("Detached browser mode is not supported by Oracle")) {
  throw new Error(`Expected detached browser guard message.\n${guardText}`);
}

const compileDir = await mkdtemp(path.join(tmpdir(), "pi-oracle-bg-"));
const compile = spawnSync(
  process.execPath,
  [
    tscCli,
    "extensions/pi-oracle/store.ts",
    "extensions/pi-oracle/background.ts",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--target",
    "ES2022",
    "--outDir",
    compileDir,
  ],
  {
    cwd: repoRoot,
    encoding: "utf8",
  },
);
if (compile.status !== 0) {
  throw new Error(`Synthetic background compile failed.\nSTDOUT:\n${compile.stdout}\nSTDERR:\n${compile.stderr}`);
}

const storeModule = await import(pathToFileURL(path.join(compileDir, "store.js")).href);
const backgroundModule = await import(pathToFileURL(path.join(compileDir, "background.js")).href);

const responseId = "validatebackground";
const responseDir = path.join(repoRoot, ".pi", "oracle", responseId);
const sessionId = "validatebackgroundsession";
const sessionDir = path.join(repoRoot, ".pi", "oracle", "oracle-home", "sessions", sessionId);
const sessionMetaPath = path.join(sessionDir, "meta.json");
const sessionLogPath = path.join(sessionDir, "output.log");

try {
  await storeModule.writeOracleMetadata(repoRoot, {
    id: responseId,
    status: "background",
    createdAt: "2026-04-16T04:00:00.000Z",
    updatedAt: "2026-04-16T04:00:00.000Z",
    engine: "api",
    model: "gpt-5.4-pro",
    prompt: "Synthetic background validation",
    files: ["README.md"],
    cwd: repoRoot,
    wait: false,
    sessionId,
    reattachCommand: `oracle session ${sessionId}`,
    exitCode: 0,
    killed: false,
    command: "node",
    args: ["oracle-cli.js"],
  });
  await storeModule.writeOracleLogs(repoRoot, responseId, "startup log");

  await mkdir(sessionDir, { recursive: true });
  await writeFile(sessionMetaPath, `${JSON.stringify({ status: "running" }, null, 2)}\n`, "utf8");
  await writeFile(sessionLogPath, "startup log\n", "utf8");

  const sent = [];
  const fakePi = {
    sendMessage(message, options) {
      sent.push({ message, options });
    },
  };

  await backgroundModule.resumeOracleBackgroundMonitors(fakePi, repoRoot, {
    pollIntervalMs: 10,
    timeoutMs: 1000,
  });

  setTimeout(async () => {
    await writeFile(sessionLogPath, "Header\nAnswer:\n\nSynthetic final answer", "utf8");
    await writeFile(
      sessionMetaPath,
      `${JSON.stringify({ status: "completed", completedAt: "2026-04-16T04:00:05.000Z" }, null, 2)}\n`,
      "utf8",
    );
  }, 20);

  await backgroundModule.waitForOracleBackgroundMonitor(responseId);
  const record = await storeModule.readOracleRecord(repoRoot, responseId);
  if (record.metadata.status !== "completed") {
    throw new Error(`Expected completed status, got ${record.metadata.status}`);
  }
  if (record.metadata.notifiedAt === undefined) {
    throw new Error("Expected notifiedAt to be set.");
  }
  if (!record.answer?.includes("Synthetic final answer")) {
    throw new Error(`Expected stored answer.\n${record.answer ?? "<missing>"}`);
  }
  if (!record.logs?.includes("Header")) {
    throw new Error(`Expected stored logs.\n${record.logs ?? "<missing>"}`);
  }
  if (sent.length !== 1) {
    throw new Error(`Expected one follow-up message, got ${sent.length}.`);
  }
  if (!String(sent[0].message.content).includes(`Background Oracle result ${responseId} is ready`)) {
    throw new Error(`Unexpected follow-up message.\n${String(sent[0].message.content)}`);
  }

  console.log(`validate:wrapper:background ok (${responseId})`);
} finally {
  await rm(responseDir, { recursive: true, force: true });
  await rm(sessionDir, { recursive: true, force: true });
  await rm(compileDir, { recursive: true, force: true });
}
