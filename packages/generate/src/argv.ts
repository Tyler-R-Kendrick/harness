export function harborArgv(dataset: string, agent: string, config?: string): string[] {
  const args = ["run", "-d", dataset, "-a", agent];
  if (config !== undefined) args.push("-c", config);
  return args;
}

export function assertArgv(config: string): string[] {
  return ["run", "--config", config];
}

export function redteamArgv(config: string): string[] {
  return ["redteam", "generate", "-c", config];
}

/** Inspect stays optional. It is not a default CLI command. */
export function inspectArgv(task: string): string[] {
  return ["eval", task];
}
