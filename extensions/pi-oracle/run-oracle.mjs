#!/usr/bin/env node
import { spawn } from "node:child_process";

const [, , oracleHomeDir, oracleCliPath, ...oracleArgs] = process.argv;

if (!oracleHomeDir || !oracleCliPath) {
  console.error("Usage: run-oracle.mjs <oracle-home-dir> <oracle-cli-path> [oracle args...]");
  process.exit(1);
}

const child = spawn(process.execPath, [oracleCliPath, ...oracleArgs], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ORACLE_HOME_DIR: oracleHomeDir,
  },
  stdio: ["inherit", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

const signalExitCodes = new Map([
  ["SIGINT", 130],
  ["SIGTERM", 143],
]);

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

const handleSigInt = () => forwardSignal("SIGINT");
const handleSigTerm = () => forwardSignal("SIGTERM");
process.on("SIGINT", handleSigInt);
process.on("SIGTERM", handleSigTerm);

child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

child.on("close", (code, signal) => {
  process.off("SIGINT", handleSigInt);
  process.off("SIGTERM", handleSigTerm);

  if (signal) {
    process.exit(signalExitCodes.get(signal) ?? 1);
    return;
  }
  process.exit(code ?? 0);
});
