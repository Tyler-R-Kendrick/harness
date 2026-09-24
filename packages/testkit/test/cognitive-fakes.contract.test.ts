import { compressorContract, documentParserContract, embedderContract, generatorContract, HashEmbedder, HeuristicCompressor, judgeContract, KeywordRouter, routerContract, ScriptedGenerator, ScriptedJudge, StubDocumentParser } from "@harness/testkit";

judgeContract("ScriptedJudge", () => new ScriptedJudge());
routerContract("KeywordRouter", () => new KeywordRouter());
embedderContract("HashEmbedder", () => new HashEmbedder(64), { sizes: [32, 16] });
compressorContract("HeuristicCompressor", () => new HeuristicCompressor());
generatorContract(
  "ScriptedGenerator",
  () =>
    new ScriptedGenerator((r) =>
      r.tools?.length
        ? "<tool_call>\n<function=get_weather>\n<parameter=city>\nLagos\n</parameter>\n</function>\n</tool_call><|im_end|>"
        : "<think>easy</think>Paris<|im_end|>",
    ),
);
documentParserContract("StubDocumentParser", () => new StubDocumentParser(), async () => ({ mediaType: "image/png", data: new Uint8Array([1, 2, 3]) }));
