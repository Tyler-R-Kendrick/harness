# 0003: Refined types for values with invariants

Status: decided, 2026-09-24.

## Question

How far should "parse, don't validate" go? Zod already parses every boundary. But
inside the code a probability was still a `number`, so functions re-checked ranges
(the cascade checked its thresholds on every call, and the Cactus adapter checked
confidences by hand). Nothing stopped bytes being passed where dimensions were meant.

## Decision

- **Branded refined types for values with invariants**, defined once as zod schemas:
  `Probability` [0, 1], `Similarity` [-1, 1], `Bytes`, `Dimensions`, `Sha256` and
  `CommitSha` (`packages/cognitive/src/units.ts`), plus branded composites such as
  `CascadePolicy` (verify <= act), `BehaviorGraph` and `BehaviorPack`. A brand makes
  the type nominal: a plain number, or another unit, is a compile error.
- **Units do not mix.** Arithmetic that keeps a unit has a helper (`sumBytes`). Plain
  arithmetic yields a `number`, which must be parsed again to become a unit.
- **Template-literal ids** (`MemoryId = m${number}`, `LessonId = l${number}`) are
  parsed with `z.templateLiteral`, so a memory id cannot be passed as a lesson id.
- **Parse where values enter.** Ports carry refined types, so adapters parse model
  output (judge answers, router confidences, engine dimensions) instead of casting it.
- **Static analysis.** ESLint forbids `as T` and `<T>` casts to refined types
  everywhere, tests included (UN2.1 pins the rule). The one sealing point that must
  make a brand (`BehaviorPack`) carries an explained, line-scoped exemption.

## Not done

- True dependent types (a vector's length in its type) are beyond TypeScript without
  heavy encodings. Embedding length is checked by parsing at the boundary instead.
- Token counts (`maxTokens`) stay plain numbers for now; they are next if a mix-up
  appears.
