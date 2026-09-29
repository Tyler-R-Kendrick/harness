/**
 * Autopilot proposes goals from a host survey and records each one as a harness
 * update on its own branch. Open Experiment Standard draft 0.1.0 has no runtime
 * package, and a vendor experiment client does not belong in the core.
 */

export type AutopilotKind = "upgrade" | "vulnerability" | "research" | "experiment";

export interface AutopilotFinding {
  readonly kind: AutopilotKind;
  readonly subject: string;
  readonly detail: string;
  readonly sourceSystem?: string;
}

export interface AutopilotGoal {
  readonly id: string;
  readonly branch: string;
  readonly kind: AutopilotKind;
  readonly subject: string;
  readonly detail: string;
  readonly steering?: string;
}

export interface OpenExperiment {
  readonly schemaVersion: "0.1.0";
  readonly objectType: "experiment";
  readonly sourceSystem?: string;
  readonly experiment: {
    readonly id: string;
    readonly title: string;
    readonly status?: ExperimentStatus;
    readonly hypothesis?: string;
  };
  readonly design?: { readonly type?: DesignType; readonly randomizationUnit?: string };
  readonly variants?: readonly { readonly id: string; readonly key: string; readonly name?: string; readonly role?: VariantRole }[];
  readonly metrics?: readonly { readonly id: string; readonly name: string; readonly role?: MetricRole; readonly direction?: MetricDirection }[];
  readonly analysis?: Readonly<Record<string, unknown>>;
  readonly results?: Readonly<Record<string, unknown>>;
  readonly scorecard?: Readonly<Record<string, unknown>>;
  readonly decision?: { readonly status?: DecisionStatus; readonly outcome?: DecisionOutcome };
  readonly qualityChecks?: readonly { readonly checkType: string }[];
  readonly artifacts?: readonly { readonly type: ArtifactType; readonly uri: string }[];
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface AutopilotUpdate {
  readonly id: string;
  readonly branch: string;
  readonly notes: string;
  readonly kind: AutopilotKind;
  readonly subject: string;
  readonly applied: boolean;
  readonly experiment?: OpenExperiment;
}

export interface AutopilotPorts {
  survey(): readonly unknown[] | Promise<readonly unknown[]>;
  implement(goal: AutopilotGoal): string | Promise<string>;
  id?(): string;
}

type ExperimentStatus = "draft" | "planned" | "running" | "stopped" | "analyzed" | "decided" | "archived";
type DesignType = "ab" | "abn" | "multivariate" | "factorial" | "holdout" | "switchback" | "bandit" | "quasi_experiment";
type VariantRole = "control" | "treatment" | "holdout" | "baseline";
type MetricRole = "primary" | "secondary" | "guardrail" | "diagnostic" | "data_quality" | "invariant";
type MetricDirection = "increase_is_good" | "decrease_is_good" | "no_change_expected" | "two_sided";
type DecisionStatus = "pending" | "decided" | "superseded";
type DecisionOutcome = "ship" | "do_not_ship" | "iterate" | "rerun" | "rollback" | "partial_rollout";
type ArtifactType = "chart" | "screenshot" | "sql" | "notebook" | "csv" | "dashboard" | "slide" | "image" | "html_report";

const KINDS = ["upgrade", "vulnerability", "research", "experiment"] as const;
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

interface GoalInput {
  readonly kind: AutopilotKind;
  readonly subject: string;
  readonly detail: string;
  readonly sourceSystem?: string;
}

export class Autopilot {
  readonly #ports: AutopilotPorts;
  readonly #updates: AutopilotUpdate[] = [];
  readonly #landed = new Set<string>();
  #running = false;
  #steering: string | undefined = undefined;
  #steeringLanded = false;
  #cursor = 0;
  #seq = 0;

  constructor(ports: AutopilotPorts) {
    this.#ports = ports;
  }

  get running(): boolean {
    return this.#running;
  }

  start(steering?: string): void {
    this.#running = true;
    this.#steering = steering;
    this.#steeringLanded = false;
  }

  interrupt(): void {
    this.#running = false;
  }

  updates(): AutopilotUpdate[] {
    return this.#updates.map((update) => ({ ...update }));
  }

  apply(id: string): AutopilotUpdate {
    const index = this.#updates.findIndex((update) => update.id === id);
    const current = this.#updates[index];
    if (current === undefined) throw new TypeError(`unknown autopilot update ${id}`);
    const next = { ...current, applied: true };
    this.#updates[index] = next;
    return { ...next };
  }

  async step(): Promise<AutopilotUpdate | undefined> {
    if (!this.#running) return undefined;
    const steering = this.#steering;
    if (steering !== undefined && !this.#steeringLanded) {
      const kind = kindOf(steering);
      if (!this.#landed.has(identity(kind, steering))) {
        const update = await this.#land({ kind, subject: steering, detail: steering }, steering);
        this.#steeringLanded = true;
        return update;
      }
      this.#steeringLanded = true;
    }
    const findings = findingsOf(await this.#ports.survey());
    const fresh = findings.filter((item) => !this.#landed.has(identity(item.kind, item.subject)));
    const picked = pick(fresh, this.#cursor);
    if (picked === undefined) return undefined;
    const update = await this.#land(picked, steering);
    this.#cursor = (KINDS.indexOf(picked.kind) + 1) % KINDS.length;
    return update;
  }

  async #land(input: GoalInput, steering: string | undefined): Promise<AutopilotUpdate> {
    const id = this.#ports.id === undefined ? this.#generated() : this.#ports.id();
    if (!ID_PATTERN.test(id) || this.#updates.some((update) => update.id === id)) throw new TypeError(`autopilot id ${id}`);
    const branch = `autopilot/${id}`;
    const goal: AutopilotGoal = {
      id,
      branch,
      kind: input.kind,
      subject: input.subject,
      detail: input.detail,
      ...(steering === undefined ? {} : { steering }),
    };
    const body = await this.#ports.implement(goal);
    if (typeof body !== "string") throw new TypeError("autopilot implement must return a string");
    const experiment = input.kind === "experiment" ? experimentFor(id, input) : undefined;
    const update: AutopilotUpdate = {
      id,
      branch,
      kind: input.kind,
      subject: input.subject,
      applied: false,
      notes: releaseNotes(input, branch, steering, body),
      ...(experiment === undefined ? {} : { experiment }),
    };
    this.#updates.push(update);
    this.#landed.add(identity(input.kind, input.subject));
    return { ...update };
  }

  #generated(): string {
    this.#seq += 1;
    return `ap-${String(this.#seq)}`;
  }
}

export function parseOpenExperiment(value: unknown): OpenExperiment {
  const record = recordOf(value, "document");
  if (record["schemaVersion"] !== "0.1.0") throw new TypeError("schemaVersion is invalid");
  if (record["objectType"] !== "experiment") throw new TypeError("objectType is invalid");
  const sourceSystem = record["sourceSystem"];
  if (sourceSystem !== undefined && typeof sourceSystem !== "string") throw new TypeError("sourceSystem is invalid");
  const experiment = experimentIdentity(record["experiment"]);
  const design = designOf(record["design"]);
  const variants = variantsOf(record["variants"]);
  const metrics = metricsOf(record["metrics"]);
  const analysis = objectSection(record["analysis"], "analysis");
  const results = objectSection(record["results"], "results");
  const scorecard = objectSection(record["scorecard"], "scorecard");
  const decision = decisionOf(record["decision"]);
  const qualityChecks = qualityOf(record["qualityChecks"]);
  const artifacts = artifactsOf(record["artifacts"]);
  const provenance = objectSection(record["provenance"], "provenance");
  const extensions = objectSection(record["extensions"], "extensions");
  return {
    schemaVersion: "0.1.0",
    objectType: "experiment",
    ...(sourceSystem === undefined ? {} : { sourceSystem }),
    experiment,
    ...(design === undefined ? {} : { design }),
    ...(variants === undefined ? {} : { variants }),
    ...(metrics === undefined ? {} : { metrics }),
    ...(analysis === undefined ? {} : { analysis }),
    ...(results === undefined ? {} : { results }),
    ...(scorecard === undefined ? {} : { scorecard }),
    ...(decision === undefined ? {} : { decision }),
    ...(qualityChecks === undefined ? {} : { qualityChecks }),
    ...(artifacts === undefined ? {} : { artifacts }),
    ...(provenance === undefined ? {} : { provenance }),
    ...(extensions === undefined ? {} : { extensions }),
  };
}

function experimentFor(id: string, input: GoalInput): OpenExperiment {
  const hypothesis = input.detail === "" ? input.subject : input.detail;
  return parseOpenExperiment({
    schemaVersion: "0.1.0",
    objectType: "experiment",
    sourceSystem: input.sourceSystem ?? "harness",
    experiment: { id, title: input.subject, status: "draft", hypothesis },
    design: { type: "ab", randomizationUnit: "session" },
    variants: [
      { id: "control", key: "control", name: "Control", role: "control" },
      { id: "treatment", key: "treatment", name: "Treatment", role: "treatment" },
    ],
    metrics: [{ id: "primary", name: input.subject, role: "primary", direction: "increase_is_good" }],
    analysis: {},
    results: {},
    scorecard: {},
    decision: { status: "pending" },
    qualityChecks: [],
    artifacts: [],
    provenance: {},
    extensions: {},
  });
}

function releaseNotes(input: GoalInput, branch: string, steering: string | undefined, body: string): string {
  const lines = [`${input.kind}: ${input.subject}`, "", `branch: ${branch}`, "not applied to the trunk"];
  if (steering !== undefined) lines.push(`steering: ${steering}`);
  if (input.detail !== input.subject && input.detail !== "") lines.push("", input.detail);
  if (body !== "") lines.push("", body);
  return lines.join("\n");
}

function kindOf(text: string): AutopilotKind {
  if (/\b(?:upgrade|upgrades|dependency|dependencies)\b/i.test(text)) return "upgrade";
  if (/\b(?:vulnerability|cve)\b/i.test(text)) return "vulnerability";
  if (/\b(?:experiment|performance)\b/i.test(text)) return "experiment";
  return "research";
}

function identity(kind: AutopilotKind, subject: string): string {
  return `${kind}\u0000${subject}`;
}

function pick(findings: readonly AutopilotFinding[], cursor: number): AutopilotFinding | undefined {
  for (let offset = 0; offset < KINDS.length; offset += 1) {
    const kind = KINDS[(cursor + offset) % KINDS.length];
    const found = findings.find((item) => item.kind === kind);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findingsOf(value: unknown): AutopilotFinding[] {
  if (!Array.isArray(value)) throw new TypeError("autopilot survey must return an array");
  return value.map((item) => {
    const record = recordOf(item, "finding");
    const kind = record["kind"];
    if (!isKind(kind)) throw new TypeError("autopilot finding kind is invalid");
    const subject = requiredText(record["subject"], "autopilot finding subject");
    const detail = record["detail"];
    if (typeof detail !== "string") throw new TypeError("autopilot finding detail is invalid");
    const sourceSystem = record["sourceSystem"];
    if (sourceSystem !== undefined && (typeof sourceSystem !== "string" || sourceSystem === "")) throw new TypeError("autopilot finding sourceSystem is invalid");
    return { kind, subject, detail, ...(sourceSystem === undefined ? {} : { sourceSystem }) };
  });
}

function isKind(value: unknown): value is AutopilotKind {
  return value === "upgrade" || value === "vulnerability" || value === "research" || value === "experiment";
}

function experimentIdentity(value: unknown): OpenExperiment["experiment"] {
  const record = recordOf(value, "experiment");
  const id = requiredText(record["id"], "experiment id");
  const title = requiredText(record["title"], "experiment title");
  const status = record["status"];
  if (status !== undefined && !isExperimentStatus(status)) throw new TypeError("experiment status is invalid");
  const hypothesis = record["hypothesis"];
  if (hypothesis !== undefined && typeof hypothesis !== "string") throw new TypeError("experiment hypothesis is invalid");
  return {
    id,
    title,
    ...(status === undefined ? {} : { status }),
    ...(hypothesis === undefined ? {} : { hypothesis }),
  };
}

function designOf(value: unknown): OpenExperiment["design"] | undefined {
  if (value === undefined) return undefined;
  const record = recordOf(value, "design");
  const type = record["type"];
  if (type !== undefined && !isDesignType(type)) throw new TypeError("design type is invalid");
  const randomizationUnit = record["randomizationUnit"];
  if (randomizationUnit !== undefined && typeof randomizationUnit !== "string") throw new TypeError("design randomizationUnit is invalid");
  return {
    ...(type === undefined ? {} : { type }),
    ...(randomizationUnit === undefined ? {} : { randomizationUnit }),
  };
}

function variantsOf(value: unknown): NonNullable<OpenExperiment["variants"]> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("variants is invalid");
  return value.map((item) => {
    const record = recordOf(item, "variant");
    const id = requiredText(record["id"], "variant id");
    const key = requiredText(record["key"], "variant key");
    const name = record["name"];
    if (name !== undefined && typeof name !== "string") throw new TypeError("variant name is invalid");
    const role = record["role"];
    if (role !== undefined && !isVariantRole(role)) throw new TypeError("variant role is invalid");
    return { id, key, ...(name === undefined ? {} : { name }), ...(role === undefined ? {} : { role }) };
  });
}

function metricsOf(value: unknown): NonNullable<OpenExperiment["metrics"]> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("metrics is invalid");
  return value.map((item) => {
    const record = recordOf(item, "metric");
    const id = requiredText(record["id"], "metric id");
    const name = requiredText(record["name"], "metric name");
    const role = record["role"];
    if (role !== undefined && !isMetricRole(role)) throw new TypeError("metric role is invalid");
    const direction = record["direction"];
    if (direction !== undefined && !isMetricDirection(direction)) throw new TypeError("metric direction is invalid");
    return { id, name, ...(role === undefined ? {} : { role }), ...(direction === undefined ? {} : { direction }) };
  });
}

function decisionOf(value: unknown): OpenExperiment["decision"] | undefined {
  if (value === undefined) return undefined;
  const record = recordOf(value, "decision");
  const status = record["status"];
  if (status !== undefined && !isDecisionStatus(status)) throw new TypeError("decision status is invalid");
  const outcome = record["outcome"];
  if (outcome !== undefined && !isDecisionOutcome(outcome)) throw new TypeError("decision outcome is invalid");
  return { ...(status === undefined ? {} : { status }), ...(outcome === undefined ? {} : { outcome }) };
}

function qualityOf(value: unknown): NonNullable<OpenExperiment["qualityChecks"]> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("qualityChecks is invalid");
  return value.map((item) => {
    const record = recordOf(item, "quality check");
    return { checkType: requiredText(record["checkType"], "quality check") };
  });
}

function artifactsOf(value: unknown): NonNullable<OpenExperiment["artifacts"]> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("artifacts is invalid");
  return value.map((item) => {
    const record = recordOf(item, "artifact");
    const type = record["type"];
    if (!isArtifactType(type)) throw new TypeError("artifact type is invalid");
    return { type, uri: requiredText(record["uri"], "artifact uri") };
  });
}

function objectSection(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return recordOf(value, name);
}

function isExperimentStatus(value: unknown): value is ExperimentStatus {
  return value === "draft" || value === "planned" || value === "running" || value === "stopped" || value === "analyzed" || value === "decided" || value === "archived";
}

function isDesignType(value: unknown): value is DesignType {
  return value === "ab" || value === "abn" || value === "multivariate" || value === "factorial" || value === "holdout" || value === "switchback" || value === "bandit" || value === "quasi_experiment";
}

function isVariantRole(value: unknown): value is VariantRole {
  return value === "control" || value === "treatment" || value === "holdout" || value === "baseline";
}

function isMetricRole(value: unknown): value is MetricRole {
  return value === "primary" || value === "secondary" || value === "guardrail" || value === "diagnostic" || value === "data_quality" || value === "invariant";
}

function isMetricDirection(value: unknown): value is MetricDirection {
  return value === "increase_is_good" || value === "decrease_is_good" || value === "no_change_expected" || value === "two_sided";
}

function isDecisionStatus(value: unknown): value is DecisionStatus {
  return value === "pending" || value === "decided" || value === "superseded";
}

function isDecisionOutcome(value: unknown): value is DecisionOutcome {
  return value === "ship" || value === "do_not_ship" || value === "iterate" || value === "rerun" || value === "rollback" || value === "partial_rollout";
}

function isArtifactType(value: unknown): value is ArtifactType {
  return value === "chart" || value === "screenshot" || value === "sql" || value === "notebook" || value === "csv" || value === "dashboard" || value === "slide" || value === "image" || value === "html_report";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordOf(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") throw new TypeError(`${name} is invalid`);
  return value;
}
