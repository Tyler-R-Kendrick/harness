import { spawnSync } from "node:child_process";

/** Any image with a POSIX shell and node: Docker's official node image, from its public ECR mirror. */
export const IMAGE = "public.ecr.aws/docker/library/node:22-bookworm-slim";
/** Where the same official image can be pulled from: the ECR mirror first, then Docker Hub. */
const SOURCES = [IMAGE, "docker.io/library/node:22-bookworm-slim"];

/**
 * Make sure the test image is on this machine: kept if present, else pulled. Public
 * registries rate-limit anonymous pulls (several CI runs pulling at once hit it), so each
 * source is tried in turn, with backoff between rounds.
 */
export function ensureImage(): void {
  if (spawnSync("docker", ["image", "inspect", IMAGE]).status === 0) return;
  const failures: string[] = [];
  for (let round = 0; round < 4; round++) {
    for (const source of SOURCES) {
      const pulled = spawnSync("docker", ["pull", "-q", source], { encoding: "utf8" });
      if (pulled.status === 0) {
        if (source !== IMAGE) spawnSync("docker", ["tag", source, IMAGE]);
        return;
      }
      failures.push(`${source}: ${pulled.stderr.trim()}`);
    }
    spawnSync("sleep", [String(2 ** (round + 1))]);
  }
  throw new Error(`the test image could not be pulled:\n${failures.join("\n")}`);
}
