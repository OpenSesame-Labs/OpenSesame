/** A genuine pseudo-terminal for the human approval integration ceremony. */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const tsxLoader = createRequire(import.meta.url).resolve("tsx");
interface ApprovalTerminalResult {
  code: number;
  output: string;
}
export async function approvalTerminal(
  env: NodeJS.ProcessEnv,
  url = "https://request.example/private?query=canary",
  reference = "op://Automation/Database/password",
): Promise<ApprovalTerminalResult> {
  const args = [
    process.execPath,
    "--import",
    tsxLoader,
    resolve("src/bin.ts"),
    "lease",
    "approve",
    url,
    "--secret",
    reference,
    "--desktop",
    "--account",
    "selected.account",
  ];
  const command = args
    .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
    .join(" ");
  return new Promise((finish, reject) => {
    const child = spawn(
      "/usr/bin/script",
      ["--quiet", "--return", "--command", command, "/dev/null"],
      { env, stdio: ["pipe", "pipe", "ignore"] },
    );
    let sent = false;
    let output = "";
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Approval terminal deadline exceeded"));
    }, 30000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (!sent && output.includes("Type approve:")) {
        sent = true;
        child.stdin.write("approve\n");
      }
    });
    child.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      finish({ code: code ?? 1, output });
    });
  });
}
