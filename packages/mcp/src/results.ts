/** A peer that omits `resultType` means the result is complete. */
export function withResultType<T extends object>(result: T): T & { resultType: string } {
  if (!("resultType" in result) || result.resultType === undefined) {
    return { ...result, resultType: "complete" };
  }
  const typed = result.resultType;
  return { ...result, resultType: typeof typed === "string" ? typed : "complete" };
}

export function textOf(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return "";
  const content = result.content;
  if (!Array.isArray(content)) return "";
  const first = content[0];
  if (!first || typeof first !== "object" || !("text" in first)) return "";
  return typeof first.text === "string" ? first.text : "";
}

export function taskIdOf(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  if ("taskId" in result && typeof result.taskId === "string") return result.taskId;
  if ("structuredContent" in result && result.structuredContent && typeof result.structuredContent === "object") {
    const structured = result.structuredContent;
    if ("taskId" in structured && typeof structured.taskId === "string") return structured.taskId;
  }
  return undefined;
}
