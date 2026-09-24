import tseslint from "typescript-eslint";
import globals from "globals";

// Portable packages must not touch host I/O, ambient time or ambient randomness.
// Everything nondeterministic arrives through injected ports, which keeps the core
// identical on every platform and makes replay/trace-parity tests meaningful.
const pureRestrictions = {
  "no-restricted-globals": [
    "error",
    ...["setTimeout", "setInterval", "clearTimeout", "clearInterval", "queueMicrotask", "fetch", "crypto",
      "process", "window", "document", "navigator", "localStorage", "indexedDB", "performance", "console",
      "require", "Buffer", "structuredClone"].map((name) => ({ name, message: "Use an injected host port." })),
  ],
  "no-restricted-properties": [
    "error",
    { object: "Math", property: "random", message: "Use the Entropy port." },
    { object: "Date", property: "now", message: "Use the Clock port." },
  ],
  "no-restricted-syntax": [
    "error",
    { selector: "NewExpression[callee.name='Date']", message: "Use the Clock port." },
    { selector: "ImportDeclaration[source.value=/^node:/]", message: "Portable packages cannot import Node builtins." },
  ],
};

// Refined types (see packages/cognitive/src/units.ts and the id schemas) are made only by
// parsing. A cast would forge one without the check, so casting to them is an error
// everywhere, tests included: construct them with their parser or schema instead.
const REFINED = "Probability|Similarity|Bytes|Dimensions|Sha256|CommitSha|CascadePolicy|BehaviorGraph|BehaviorPack|MemoryId|LessonId";
const refinedRestrictions = ["TSAsExpression", "TSTypeAssertion"].map((cast) => ({
  selector: `${cast} > TSTypeReference.typeAnnotation[typeName.name=/^(${REFINED})$/]`,
  message: "Refined types are made by parsing: use the type's constructor or schema, not a cast.",
}));
pureRestrictions["no-restricted-syntax"].push(...refinedRestrictions);

export default tseslint.config(
  { ignores: ["**/node_modules/**", "coverage/**", "reports/**", ".stryker-tmp/**", "**/.types/**"] },
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-restricted-syntax": ["error", ...refinedRestrictions],
    },
  },
  {
    files: ["packages/{core,protocol,cognitive,testkit,behavior,memory,learning}/src/**/*.ts"],
    languageOptions: { globals: {} },
    rules: pureRestrictions,
  },
);
