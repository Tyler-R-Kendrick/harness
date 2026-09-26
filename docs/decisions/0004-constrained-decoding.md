# 0004: Constrained decoding with XGrammar

Status: decided, 2026-09-24.

## Question

How should generation be held to a shape? We want JSON that parses, tool code in a fixed
scaffold, and answers whose fixed parts are free, so that inference spends tokens only
where the model decides something.

## Decision

- **A constraint is part of a generation request** (`GenerateRequest.constraint`): a JSON
  Schema, a grammar (EBNF), a regular expression, or a **template**. A template is fixed
  text with holes, each optionally constrained itself. `readTemplate` reads an answer
  back into its holes, and consumers parse that answer as they would any other.
- **Enforcement is declared as data.** A catalog entry lists the constraint kinds its
  runtime enforces. The ensemble sends a constrained request to those generators first,
  and to the others only as a fallback, where the constraint is a preference.
- **The engine is XGrammar** (`@mlc-ai/web-xgrammar`, WebAssembly, runs in browsers and
  Node), wrapped by `@harness/constrained`. It provides:
  - token masks from its adaptive mask cache;
  - templates compiled as XGrammar-2 structural tags (`const_string`, tags whose content
    is `any_text`, `json_schema`, `grammar` or `regex`, ending at the next fixed text);
  - jump-forward strings, the text a constraint forces.
- **Where it runs:**
  - The steerable kernel's own decode loop masks every step and feeds forced text in the
    same forward pass, so a template's fixed parts cost no sampling steps.
  - transformers.js generators mask through a logits processor. Its loop has no
    jump-forward.
  - llama.cpp-server enforces JSON Schema itself (structured output).
- **Fault isolation.** XGrammar aborts its WebAssembly instance on a grammar it cannot
  parse. The engine reloads a fresh instance and reports a clean error, so one bad
  client grammar cannot disable constrained decoding for later requests.

## Alternatives

- llguidance and Outlines: no maintained browser/WASM build that fits our platform
  layers.
- Validating after generation and retrying: kept as the fallback for generators that
  cannot enforce constraints, but it spends a whole generation per failure.

## Revisit when

- The web binding lags XGrammar-2's Python releases in a way we need (it already has
  structural tags and triggered tags).
- A runtime we add (for example a hosted API) offers grammar-constrained decoding.
