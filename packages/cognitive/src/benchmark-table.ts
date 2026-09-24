// Benchmark results the model selector compares: model|task|benchmark|metric|score|setting.
// Edit freely. A score written <n is lower-is-better; comparisons need the same benchmark,
// metric and setting. See parseBenchmarks in benchmarks.ts.
export const BENCHMARKS = `
typesafe-ai/jev|judgment|JevBench v1.0 (242 decisions)|accuracy|96.3
typesafe-ai/jev|judgment|JevBench v1.0 (242 decisions)|ECE|<0.027
typesafe-ai/jev|classification|SST-2 (n=500)|accuracy|95.4
typesafe-ai/jev|classification|SST-2 (n=500)|ECE|<0.026
typesafe-ai/jev|classification|AG News (n=500)|accuracy|84.3
typesafe-ai/jev|classification|Banking77 (n=500)|accuracy|76.4
Cactus-Compute/needle3|tool-calling|Mobile Actions (961)|exact-call accuracy|86|Needle 3 card chart
Cactus-Compute/needle3|tool-calling|DroidCall (200)|exact calls in order|47|Needle 3 card chart
Cactus-Compute/needle3|tool-calling|BFCL v4 (3,641)|AST-match accuracy|50.2|Needle 3 card chart
Cactus-Compute/needle3|structured-extraction|DSTC8 (1,813 turns)|field micro-F1|40.7|Needle 3 card chart
Cactus-Compute/needle3|structured-extraction|SNIPS gold (700)|field micro-F1|30.2|Needle 3 card chart
Cactus-Compute/needle3|structured-extraction|SNIPS 7-way (700)|field micro-F1|24.7|Needle 3 card chart
microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank|prompt-compression|MeetingBank QA|exact match|85.82|3.0x, GPT-3.5-Turbo target
microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank|prompt-compression|LongBench (avg)|score|38.2|2k-token budget (5x), GPT-3.5-Turbo target
microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank|prompt-compression|LongBench (avg)|score|41.9|3k-token budget (3x), GPT-3.5-Turbo target
Qwen/Qwen3.5-0.8B|chat|MMLU-Pro|accuracy|29.7|non-thinking
Qwen/Qwen3.5-0.8B|chat|MMLU-Pro|accuracy|42.3|thinking
Qwen/Qwen3.5-0.8B|chat|MMLU-Redux|accuracy|48.5|non-thinking
Qwen/Qwen3.5-0.8B|chat|IFEval|accuracy|52.1|non-thinking
Qwen/Qwen3.5-0.8B|reasoning|SuperGPQA|accuracy|16.9|non-thinking
Qwen/Qwen3.5-0.8B|reasoning|GPQA|accuracy|11.9|thinking
Qwen/Qwen3.5-0.8B|tool-calling|BFCL-V4|score|25.3|thinking
Qwen/Qwen3.5-0.8B|tool-calling|TAU2-Bench|score|11.6|thinking
Qwen/Qwen3.5-0.8B|tool-calling|Mobile Actions (961)|exact-call accuracy|76|Needle 3 card chart
Qwen/Qwen3.5-0.8B|tool-calling|DroidCall (200)|exact calls in order|28|Needle 3 card chart
Qwen/Qwen3.5-0.8B|tool-calling|BFCL v4 (3,641)|AST-match accuracy|56.8|Needle 3 card chart
Qwen/Qwen3.5-0.8B|structured-extraction|DSTC8 (1,813 turns)|field micro-F1|49|Needle 3 card chart
Qwen/Qwen3.5-0.8B|structured-extraction|SNIPS gold (700)|field micro-F1|35|Needle 3 card chart
Qwen/Qwen3.5-0.8B|structured-extraction|SNIPS 7-way (700)|field micro-F1|34|Needle 3 card chart
Qwen/Qwen3.5-0.8B|vision-qa|MMMU|accuracy|47.4|non-thinking
Qwen/Qwen3.5-0.8B|vision-qa|RealWorldQA|accuracy|61.6|non-thinking
Qwen/Qwen3.5-0.8B|vision-qa|MMBench-EN-DEV v1.1|accuracy|68|non-thinking
Qwen/Qwen3.5-0.8B|ocr|OCRBench|score|79.1|non-thinking
Qwen/Qwen3.5-0.8B|ocr|CC-OCR|score|66.7|non-thinking
Qwen/Qwen3.5-0.8B|document-parsing|OmniDocBench v1.5|overall|70.6|non-thinking
Qwen/Qwen3.5-0.8B|document-parsing|MMLongBench-Doc|accuracy|28.1|non-thinking
Qwen/Qwen3.5-0.8B|chart-understanding|CharXiv (RQ)|accuracy|38.2|non-thinking
ornith-ai/Ornith-1.5-9B|coding|SWE-bench Verified|resolved %|70.6|OpenHands, 256K context
ornith-ai/Ornith-1.5-9B|coding|SWE-bench Pro|resolved %|47.5|OpenHands, 256K context
ornith-ai/Ornith-1.5-9B|coding|Terminal-Bench 2.1|accuracy|46.2|Terminus-2, 128K context
ornith-ai/Ornith-1.5-9B|reasoning|GPQA Diamond|accuracy|86.4
ornith-ai/Ornith-1.5-9B|reasoning|HLE|accuracy|20.2|no tools
ornith-ai/Ornith-1.5-9B|tool-calling|MCP-Atlas|score|54.2|thinking, 500-task public subset
ornith-ai/Ornith-1.5-9B|tool-calling|Toolathlon-Verified|score|41.2|128K token limit
lightonai/LightOnOCR-2-1B|document-parsing|olmOCR-Bench|overall|83.2
ATH-MaaS/OvisOCR2|document-parsing|OmniDocBench v1.6|overall|96.58
ATH-MaaS/OvisOCR2|ocr|OmniDocBench v1.6|text edit distance|<0.025
ATH-MaaS/OvisOCR2|table-extraction|OmniDocBench v1.6|table TEDS|94.76
`;
