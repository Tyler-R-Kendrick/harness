import sharp from "sharp";
import { cosine, decideToolCalls } from "@harness/cognitive";
import type { Ensemble, ImageInput } from "@harness/cognitive";
import type { EvalCase } from "../runner.ts";

/**
 * The cognitive core judged by Jev: each case runs real work on the ensemble (tool
 * decisions, compression, OCR, vision, retrieval) and Jev decides whether the result
 * is right. Every state names the model that produced it.
 */

const TOOLS = [
  { name: "set_timer", description: "Start a countdown timer.", parameters: { type: "object", properties: { minutes: { type: "integer" } }, required: ["minutes"] } },
  { name: "get_weather", description: "Get the current weather for a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  { name: "send_email", description: "Send an email to a contact.", parameters: { type: "object", properties: { to: { type: "string" }, body: { type: "string" } }, required: ["to", "body"] } },
];

const NOTE =
  "Um, so, basically the thing is, the quarterly budget review has been moved, you know, from Tuesday to Thursday at 3pm, and, uh, Sarah from finance will be presenting the updated hiring plan for the payments team, so everyone please bring your headcount numbers.";

const INVOICE = { number: "4521", vendor: "Acme Corporation", lines: [["Widget", "3", "30.00"], ["Gadget", "1", "45.50"]], total: "75.50" };

async function png(svg: string): Promise<ImageInput> {
  return { mediaType: "image/png", data: new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer()) };
}

function invoiceSvg(): string {
  const rows = INVOICE.lines.map(([item, qty, price], i) => `<text x="70" y="${320 + i * 50}">${item}</text><text x="600" y="${320 + i * 50}">${qty}</text><text x="780" y="${320 + i * 50}">${price}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="600"><rect width="100%" height="100%" fill="white"/><g font-family="DejaVu Sans" font-size="26">
    <text x="60" y="90" font-size="44" font-weight="bold">Invoice ${INVOICE.number}</text><text x="60" y="150">${INVOICE.vendor}</text>
    <text x="70" y="260">Item</text><text x="600" y="260">Qty</text><text x="780" y="260">Price</text>${rows}
    <text x="70" y="460">Total</text><text x="780" y="460">${INVOICE.total}</text></g></svg>`;
}

export function cognitiveSuite(ensemble: () => Promise<Ensemble>): readonly EvalCase[] {
  return [
    {
      id: "cognitive.tool-decision",
      description: "The tool cascade picks the right calls, in order, with arguments from the request",
      subject: async () => {
        const request = "Set a 10 minute timer, then tell me the weather in Tokyo.";
        const decision = await decideToolCalls(await ensemble(), { input: request, tools: TOOLS });
        return { request, tools: TOOLS.map((t) => t.name), calls: decision.calls, decidedBy: decision.decidedBy, model: decision.trace.at(-1)?.member ?? "none" };
      },
      questions: {
        correct: {
          type: "boolean",
          instructions: "Do `calls` do exactly what `request` asks, in order, using only `tools`, with every argument taken from the request and no extra calls?",
        },
      },
      expect: { correct: { type: "boolean", expect: true } },
    },
    {
      id: "cognitive.compression-keeps-facts",
      description: "Prompt compression drops filler but keeps the facts needed to act",
      subject: async () => {
        const e = await ensemble();
        const { id, port } = await e.resolve("prompt-compression", "compressor");
        const r = await port.compress({ text: NOTE, rate: 0.5 });
        return { original: NOTE, compressed: r.text, ratio: r.compressedTokens / r.originalTokens, model: id };
      },
      questions: {
        facts: {
          type: "boolean",
          instructions: "Using only `compressed`, could someone correctly answer: what meeting moved, to which day and time, who presents, and what to bring? (`original` is the uncompressed text.)",
        },
      },
      expect: { facts: { type: "boolean", expect: true } },
    },
    {
      id: "cognitive.document-ocr",
      description: "Document parsing reads a rendered invoice faithfully",
      subject: async () => {
        const e = await ensemble();
        const { id, port } = await e.resolve("document-parsing", "document-parser");
        const { pages } = await port.parse({ pages: [await png(invoiceSvg())] });
        return { truth: INVOICE, markdown: pages[0]?.markdown ?? "", model: id };
      },
      questions: {
        faithful: {
          type: "boolean",
          instructions: "Does `markdown` contain the invoice number, the vendor, both line items with their quantities and prices, and the total exactly as in `truth`, with nothing invented?",
        },
      },
      expect: { faithful: { type: "boolean", expect: true } },
    },
    {
      id: "cognitive.vision-answer",
      description: "The vision model describes a rendered scene correctly",
      subject: async () => {
        const e = await ensemble();
        const scene = await png(
          `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="100%" height="100%" fill="white"/><circle cx="110" cy="150" r="80" fill="#e00000"/><rect x="240" y="80" width="120" height="140" fill="#0000e0"/></svg>`,
        );
        const { id, port } = await e.resolve("vision-qa", "generator");
        let answer = "";
        for await (const ev of port.generate({ messages: [{ role: "user", content: [{ type: "image", image: scene }, { type: "text", text: "Describe the shapes and their colors in one sentence." }] }], maxTokens: 64 })) {
          if (ev.type === "text") answer += ev.text;
        }
        return { scene: "a red circle on the left and a blue square on the right, on white", answer, model: id };
      },
      questions: {
        accurate: { type: "boolean", instructions: "Does `answer` describe the shapes in `scene` (a circle and a square) without naming shapes that are not there?" },
      },
      expect: { accurate: { type: "boolean", expect: true } },
    },
    {
      id: "cognitive.retrieval",
      description: "Embeddings put the document that answers the query first",
      subject: async () => {
        const e = await ensemble();
        const query = "How do I reset my password?";
        const docs = [
          "To change your password, open Settings, choose Security and click Reset password.",
          "Our office is closed on public holidays.",
          "Invoices are emailed on the first business day of each month.",
        ];
        const { id, port } = await e.resolve("text-embedding", "embedder");
        const [q, ...vs] = await port.embed([{ kind: "query", text: query }, ...docs.map((text) => ({ kind: "document" as const, text }))]);
        const ranked = docs.map((doc, i) => ({ doc, score: cosine(q!, vs[i]!) })).sort((a, b) => b.score - a.score);
        return { query, top: ranked[0]!.doc, ranking: ranked.map((r) => r.doc), model: id };
      },
      questions: { relevant: { type: "boolean", instructions: "Does `top` answer `query`?" } },
      expect: { relevant: { type: "boolean", expect: true } },
    },
  ];
}
