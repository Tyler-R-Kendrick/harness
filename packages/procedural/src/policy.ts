/**
 * The access policy (plan §8.3): who may do what to which graph, as configuration. A
 * policy is data, parsed here, with rules whose session conditions are the resolver's
 * (`meta`, `cwdUnder`, `principal`) plus the actions and graphs they cover. The first
 * matching rule decides; with no match, the policy's default does; with no policy at
 * all, everything is allowed (the capability that reaches `procedural.*` is the grant).
 */
import { z } from "zod";
import type { GraphId } from "./graph.ts";
import { matches, WhenSchema } from "./resolver.ts";
import type { ResolveContext } from "./resolver.ts";

/** The operations a policy can allow or deny. */
export const ACTIONS = ["read", "write", "dream", "revert", "import", "approve"] as const;
export type Action = (typeof ACTIONS)[number];

const PolicyRuleSchema = z.strictObject({
  when: WhenSchema.extend({
    /** The actions the rule covers; all of them when absent. */
    actions: z.array(z.enum(ACTIONS)).min(1).exactOptional(),
    /** The graphs the rule covers, as a pattern where `*` is any run of characters; all when absent. */
    graph: z.string().min(1).exactOptional(),
  }),
  allow: z.boolean(),
});

/** An access policy, made only by `parsePolicy`. */
export const AccessPolicySchema = z
  .strictObject({
    $schema: z.string().exactOptional(),
    rules: z.array(PolicyRuleSchema),
    /** What an action no rule matches gets. */
    default: z.enum(["allow", "deny"]).default("allow"),
  })
  .brand<"AccessPolicy">();
export type AccessPolicy = z.output<typeof AccessPolicySchema>;

/** Parse an access policy; any problem refuses it whole, naming where. */
export function parsePolicy(input: unknown): AccessPolicy {
  const result = AccessPolicySchema.safeParse(input);
  if (!result.success) throw new RangeError(`invalid procedural access policy\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** JSON Schema for a policy file, for editors. */
export const policyJsonSchema = (): object => z.toJSONSchema(AccessPolicySchema, { io: "input" });

/** Whether `text` matches `pattern`, where `*` is any run of characters (none included) and everything else is literal. */
export function globMatches(pattern: string, text: string): boolean {
  const parts = pattern.split("*");
  const first = parts[0]!;
  if (parts.length === 1) return text === pattern;
  const last = parts.at(-1)!;
  if (text.length < first.length + last.length || !text.startsWith(first) || !text.endsWith(last)) return false;
  let at = first.length;
  const end = text.length - last.length;
  for (const middle of parts.slice(1, -1)) {
    const found = text.indexOf(middle, at);
    if (found === -1 || found + middle.length > end) return false;
    at = found + middle.length;
  }
  return true;
}

/** Whether `action` on `graph` is allowed for the session. The default, with no policy, is to allow. */
export function authorize(policy: AccessPolicy | undefined, action: Action, graph: GraphId, context: ResolveContext): boolean {
  if (policy === undefined) return true;
  const rule = policy.rules.find(
    ({ when }) => (when.actions === undefined || when.actions.includes(action)) && (when.graph === undefined || globMatches(when.graph, graph)) && matches(when, context),
  );
  return rule === undefined ? policy.default === "allow" : rule.allow;
}
