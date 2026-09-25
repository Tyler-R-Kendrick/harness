import { compressorContract, documentParserContract, embedderContract, generatorContract, hashEmbeddingModel, HeuristicCompressor, judgeContract, keywordRouterModel, routerContract, scriptedJudge, scriptedModel, stubDocumentParser } from "@harness/testkit";

judgeContract("scriptedJudge", () => scriptedJudge());
routerContract("keywordRouterModel", () => keywordRouterModel());
embedderContract("hashEmbeddingModel", () => hashEmbeddingModel(64), { size: 64, sizes: [32, 16] });
compressorContract("HeuristicCompressor", () => new HeuristicCompressor());
generatorContract("scriptedModel", () =>
  scriptedModel((options) =>
    options.tools?.length ? "<tool_call>\n<function=get_weather>\n<parameter=city>\nLagos\n</parameter>\n</function>\n</tool_call><|im_end|>" : "<think>easy</think>Paris<|im_end|>",
  ),
);
documentParserContract("stubDocumentParser", () => stubDocumentParser(), async () => ({ mediaType: "image/png", data: new Uint8Array([1, 2, 3]) }));
