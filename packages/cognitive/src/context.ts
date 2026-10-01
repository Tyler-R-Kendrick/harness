import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import type { Compression, CompressRequest } from "./ports.ts";

type Measure = (request: CompressRequest) => Promise<Pick<Compression, "text" | "originalTokens">>;

/**
 * Leading system messages are the cache prefix. The current turn is the last user
 * message and everything after it. Only the context between those two is compacted.
 */
function split(prompt: LanguageModelV4Prompt): { prefix: LanguageModelV4Prompt; middle: LanguageModelV4Prompt; suffix: LanguageModelV4Prompt } {
  let prefixEnd = 0;
  while (prefixEnd < prompt.length && prompt[prefixEnd]?.role === "system") prefixEnd++;
  let suffixStart = prompt.length;
  for (let i = prompt.length - 1; i >= prefixEnd; i--) {
    if (prompt[i]?.role === "user") {
      suffixStart = i;
      break;
    }
  }
  if (suffixStart === prompt.length && prefixEnd < prompt.length) suffixStart = prompt.length - 1;
  return { prefix: prompt.slice(0, prefixEnd), middle: prompt.slice(prefixEnd, suffixStart), suffix: prompt.slice(suffixStart) };
}

function texts(message: LanguageModelV4Prompt[number]): string[] {
  if (message.role === "system") return message.content.length > 0 ? [message.content] : [];
  if (message.role === "user" || message.role === "assistant") return message.content.flatMap((part) => (part.type === "text" && part.text.length > 0 ? [part.text] : []));
  return [];
}

const joined = (messages: LanguageModelV4Prompt) => messages.flatMap(texts).join("\n");

/** UTF-8 bytes of a string: a token always encodes at least one byte, so this bounds any token count. */
const utf8 = (text: string): number => {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
};

const bytes = (messages: LanguageModelV4Prompt) => messages.flatMap(texts).reduce((n, text) => n + utf8(text), 0);

/**
 * Fit a prompt to `budget` compressor tokens. The system prefix and the current turn stay
 * byte-identical, so a prefix cache still hits and a template in either span is never shortened,
 * even when those spans already exceed the budget. Only the middle is compressed, and only then.
 * A prompt whose UTF-8 bytes fit in the budget cannot exceed it in tokens, so the compressor stays idle.
 */
export async function compactContext(prompt: LanguageModelV4Prompt, budget: number, compress: Measure): Promise<LanguageModelV4Prompt> {
  const { prefix, middle, suffix } = split(prompt);
  if (middle.length === 0 || bytes(prompt) <= budget) return prompt;
  const count = async (text: string) => (text.length === 0 ? 0 : (await compress({ text, rate: 1 })).originalTokens);
  const middleText = joined(middle);
  const [prefixTokens, middleTokens, suffixTokens] = await Promise.all([count(joined(prefix)), count(middleText), count(joined(suffix))]);
  if (prefixTokens + middleTokens + suffixTokens <= budget) return prompt;
  const room = budget - prefixTokens - suffixTokens;
  if (room < 1 || middleTokens < 1) return [...prefix, ...suffix];
  const rate = Math.min(1, room / middleTokens);
  if (rate >= 1) return prompt;
  const text = (await compress({ text: middleText, rate })).text.trim();
  const compacted: LanguageModelV4Prompt[number] = { role: "user", content: [{ type: "text", text }] };
  return text.length > 0 ? [...prefix, compacted, ...suffix] : [...prefix, ...suffix];
}
