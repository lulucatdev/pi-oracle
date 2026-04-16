import { spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const extensionPath = path.join(repoRoot, "extensions", "pi-oracle", "index.ts");

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

const prompt = [
  'First call oracle_consult exactly once with prompt "validate retrieve",',
  'files ["/definitely/missing/validate-retrieve.txt"], engine "browser",',
  'model "gpt-5.4-pro", wait true.',
  'If that tool call fails and the error text includes a Response ID,',
  'call get_oracle_content exactly once with that responseId and section "logs".',
  'Then stop.',
].join(" ");

const stdout = runPiJson(prompt);
const events = parseJsonLines(stdout);
const toolExecutions = events.filter((event) => event.type === "tool_execution_end");
const oracleResult = toolExecutions.find((event) => event.toolName === "oracle_consult");
const getResult = toolExecutions.find((event) => event.toolName === "get_oracle_content");

if (!oracleResult) {
  throw new Error(`Expected oracle_consult to run.\n${stdout}`);
}
if (!getResult || getResult.isError !== false) {
  throw new Error(`Expected get_oracle_content to succeed.\n${stdout}`);
}

const oracleText = oracleResult.result?.content?.[0]?.text ?? "";
const oracleDetails = oracleResult.result?.details ?? {};
if (oracleDetails.error !== true || oracleDetails.status !== "failed") {
  throw new Error(`Expected oracle_consult to preserve structured failed-run metadata.\n${JSON.stringify(oracleResult, null, 2)}`);
}
const responseId = typeof oracleDetails.responseId === "string"
  ? oracleDetails.responseId
  : oracleText.match(/Response ID: ([A-Za-z0-9_-]+)/)?.[1];
if (!responseId) {
  throw new Error(`Expected oracle_consult failure details to include a response id.\n${oracleText}`);
}
if (!Array.isArray(oracleDetails.storedSections) || !oracleDetails.storedSections.includes("logs")) {
  throw new Error(`Expected oracle_consult failure details to advertise stored log retrieval.\n${JSON.stringify(oracleDetails, null, 2)}`);
}

const retrievedText = getResult.result?.content?.[0]?.text ?? "";
if (!retrievedText.includes("validate-retrieve.txt")) {
  throw new Error(`Expected retrieved logs to mention the missing file path.\n${retrievedText}`);
}

const storedLogsPath = path.join(repoRoot, ".pi", "oracle", responseId, "logs.txt");
const storedLogs = await readFile(storedLogsPath, "utf8");
if (storedLogs.trim() !== retrievedText.trim()) {
  throw new Error(
    `Retrieved logs do not match stored logs.\nRetrieved:\n${retrievedText}\n\nStored:\n${storedLogs}`,
  );
}

await rm(path.join(repoRoot, ".pi", "oracle", responseId), { recursive: true, force: true });
console.log(`validate:wrapper:retrieve ok (${responseId})`);
