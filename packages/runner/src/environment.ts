import type { FailureClass, ToolCall } from "@harness/ir";

/** In-process tool host. Graders read the snapshot, not the disk. */
export class InProcessEnvironment {
  readonly kind = "process" as const;
  readonly turns: string[] = [];
  readonly tools: ToolCall[] = [];
  readonly files: string[] = [];
  behavior: "complied" | "refused" = "complied";

  say(text: string): void {
    this.turns.push(text);
  }

  callTool(name: string, args?: Record<string, unknown>): void {
    this.tools.push(args === undefined ? { name } : { name, args });
  }

  write(path: string): void {
    this.files.push(path);
  }

  refuse(): void {
    this.behavior = "refused";
  }
}

/** A parsed Harbor job the caller already produced. The runner does not launch Harbor. */
export interface HarborEnvironment {
  readonly kind: "harbor";
  readonly handle: string;
  readonly view: {
    output: string;
    tools: ToolCall[];
    files: string[];
    behavior: "complied" | "refused" | "errored";
    failureClass?: FailureClass;
    passed: boolean;
  };
}

export type Environment = InProcessEnvironment | HarborEnvironment;

export interface AgentContext {
  caseId: string;
  trial: number;
}

export interface Agent {
  run(instruction: string, env: Environment, ctx: AgentContext): Promise<void>;
}
