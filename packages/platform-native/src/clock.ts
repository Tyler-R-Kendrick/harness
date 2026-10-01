import { jsonSchema, tool } from "ai";
import type { ToolSet } from "ai";
import type { ToolContext } from "@harness/workers";

/** What the clock tool tells the model. */
export interface ClockReading {
  readonly utc: string;
  readonly local: string;
  readonly timeZone: string;
}

/** Local date and time with a numeric offset, so the stamp is the same instant as `date`. */
function localStamp(date: Date): string {
  const pad = (value: number): string => String(Math.trunc(Math.abs(value))).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = Math.trunc(Math.abs(offset) / 60);
  const minutes = Math.abs(offset) % 60;
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${milliseconds}${sign}${pad(hours)}:${pad(minutes)}`;
}

/** The system clock as a model tool. `now` supplies the instant; the host clock is the default. */
export function clockTool(now: () => Date = () => new Date()) {
  return tool({
    description: "Read the current local date, time, and time zone. Use this to answer what the date or time is now.",
    inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
    execute: async (): Promise<ClockReading> => {
      const date = now();
      return { utc: date.toISOString(), local: localStamp(date), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC" };
    },
  });
}

/** The turn's tools plus the clock. The clock always reads the system time, under the name `clock`. */
export function sessionTools(
  base?: ToolSet | ((turn: ToolContext) => ToolSet | Promise<ToolSet>),
  now: () => Date = () => new Date(),
): (turn: ToolContext) => Promise<ToolSet> {
  return async (turn) => {
    const offered = base === undefined ? {} : typeof base === "function" ? await base(turn) : base;
    return { ...offered, clock: clockTool(now) };
  };
}
