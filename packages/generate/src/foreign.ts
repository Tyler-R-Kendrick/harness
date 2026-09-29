import { execa } from "execa";

export interface ForeignResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ForeignExec = (bin: string, args: readonly string[]) => Promise<ForeignResult>;

async function execaExec(bin: string, args: readonly string[]): Promise<ForeignResult> {
  const result = await execa(bin, [...args], { reject: false });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
}

export async function runForeign(bin: string, args: readonly string[], exec: ForeignExec = execaExec): Promise<ForeignResult> {
  return exec(bin, args);
}
