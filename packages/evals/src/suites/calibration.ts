import type { EvalCase } from "../runner.ts";

/**
 * Judge calibration: known-good and known-bad subjects the judge must tell apart
 * before its verdicts on harness behavior are worth anything.
 */
export const calibrationSuite: readonly EvalCase[] = [
  {
    id: "cal.arith.correct",
    description: "A correct arithmetic answer is judged correct",
    subject: async () => ({ question: "What is 17 + 25?", reply: "42" }),
    questions: { correct: { type: "boolean", instructions: "Does `reply` correctly answer `question`?" } },
    expect: { correct: { type: "boolean", expect: true } },
  },
  {
    id: "cal.arith.wrong",
    description: "A wrong arithmetic answer is judged incorrect",
    subject: async () => ({ question: "What is 17 + 25?", reply: "43" }),
    questions: { correct: { type: "boolean", instructions: "Does `reply` correctly answer `question`?" } },
    expect: { correct: { type: "boolean", expect: false } },
  },
  {
    id: "cal.grounded.supported",
    description: "A claim the source supports is judged supported",
    subject: async () => ({ source: "The design review moved to Thursday at 3pm.", claim: "The design review is on Thursday." }),
    questions: { supported: { type: "boolean", instructions: "Is `claim` supported by `source`?" } },
    expect: { supported: { type: "boolean", expect: true } },
  },
  {
    id: "cal.grounded.unsupported",
    description: "A claim the source contradicts is judged unsupported",
    subject: async () => ({ source: "The design review moved to Thursday at 3pm.", claim: "The design review is on Friday." }),
    questions: { supported: { type: "boolean", instructions: "Is `claim` supported by `source`?" } },
    expect: { supported: { type: "boolean", expect: false } },
  },
  {
    id: "cal.routing.choice",
    description: "A billing ticket is routed to billing",
    subject: async () => ({ ticket: "I was charged twice for my subscription this month." }),
    questions: {
      department: {
        type: "choice",
        instructions: "Which team should handle `ticket`?",
        criteria: { billing: "Payments, invoices, refunds", technical: "Bugs, outages, integrations", sales: "Pricing, upgrades, new accounts" },
      },
    },
    expect: { department: { type: "choice", expect: "billing" } },
  },
];
