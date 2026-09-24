import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";

export type EffectStatus = "intended" | "dispatched" | "outcome_unknown" | "succeeded" | "failed";
export type AttemptStatus = "dispatched" | "succeeded" | "failed" | "unknown";

export interface Attempt {
  readonly attemptId: string;
  readonly epoch: number;
  readonly status: AttemptStatus;
}

export interface EffectRecord {
  readonly effectId: string;
  readonly target: string;
  readonly intentKey: string;
  readonly idempotent: boolean;
  readonly status: EffectStatus;
  readonly attempts: readonly Attempt[];
}

export interface Intent {
  readonly effectId: string;
  readonly target: string;
  /** Canonical description of what the effect does; changed meaning needs a new effect id. */
  readonly intentKey: string;
  /** Whether the target itself dedupes repeated delivery of this effect. */
  readonly idempotent: boolean;
  readonly epoch: number;
}

export type LedgerError =
  | "stale_epoch"
  | "intent_changed"
  | "unknown_effect"
  | "unknown_attempt"
  | "duplicate_attempt"
  | "in_flight"
  | "already_settled"
  | "needs_reconciliation"
  | "conflicting_receipt"
  | "not_unknown";

interface MutableEffect {
  effectId: string;
  target: string;
  intentKey: string;
  idempotent: boolean;
  status: EffectStatus;
  attempts: { attemptId: string; epoch: number; status: AttemptStatus }[];
}

/**
 * Durable record of external effects. Intent is recorded before dispatch; a retry keeps
 * the logical effect id and gets a new attempt; a crash turns in-flight work into
 * outcome-unknown, which must be reconciled before a non-idempotent retry. Writers
 * carry an ownership epoch and stale owners are fenced out.
 */
export class EffectLedger {
  #epoch = 1;
  #effects = new Map<string, MutableEffect>();

  epoch(): number {
    return this.#epoch;
  }

  fence(epoch: number): void {
    if (epoch <= this.#epoch) throw new Error(`epoch must move forward (${epoch} <= ${this.#epoch})`);
    this.#epoch = epoch;
  }

  intend(intent: Intent): Result<EffectRecord, LedgerError> {
    if (intent.epoch !== this.#epoch) return stale(intent.epoch, this.#epoch);
    const existing = this.#effects.get(intent.effectId);
    if (existing) {
      if (existing.target !== intent.target || existing.intentKey !== intent.intentKey) {
        return err("intent_changed", `effect ${intent.effectId} was recorded with a different intent`);
      }
      return ok(copy(existing));
    }
    const effect: MutableEffect = {
      effectId: intent.effectId,
      target: intent.target,
      intentKey: intent.intentKey,
      idempotent: intent.idempotent,
      status: "intended",
      attempts: [],
    };
    this.#effects.set(intent.effectId, effect);
    return ok(copy(effect));
  }

  dispatch(effectId: string, attemptId: string, epoch: number): Result<Attempt, LedgerError> {
    if (epoch !== this.#epoch) return stale(epoch, this.#epoch);
    const effect = this.#effects.get(effectId);
    if (!effect) return err("unknown_effect", `no intent recorded for ${effectId}`);
    if (effect.status === "succeeded" || effect.status === "failed") return err("already_settled", `${effectId} is ${effect.status}`);
    if (effect.status === "dispatched") return err("in_flight", `${effectId} already has an attempt in flight`);
    if (effect.status === "outcome_unknown" && !effect.idempotent) {
      return err("needs_reconciliation", `${effectId} may already have happened; reconcile before retrying`);
    }
    if (effect.attempts.some((a) => a.attemptId === attemptId)) return err("duplicate_attempt", `attempt ${attemptId} already exists`);
    const attempt = { attemptId, epoch, status: "dispatched" as const };
    effect.attempts.push(attempt);
    effect.status = "dispatched";
    return ok({ ...attempt });
  }

  receipt(effectId: string, attemptId: string, outcome: "succeeded" | "failed", epoch: number): Result<EffectRecord, LedgerError> {
    if (epoch !== this.#epoch) return stale(epoch, this.#epoch);
    const effect = this.#effects.get(effectId);
    if (!effect) return err("unknown_effect", `no effect ${effectId}`);
    const attempt = effect.attempts.find((a) => a.attemptId === attemptId);
    if (!attempt) return err("unknown_attempt", `no attempt ${attemptId} for ${effectId}`);
    const settled = effect.status === "succeeded" || effect.status === "failed";
    const contradictsReconciliation = effect.status === "intended" && outcome === "succeeded";
    if ((settled && effect.status !== outcome) || contradictsReconciliation) {
      return err("conflicting_receipt", `${effectId} is ${effect.status}; receipt says ${outcome}`);
    }
    attempt.status = outcome;
    // A success from any attempt means the effect happened. A failure only settles the
    // effect if it comes from the latest attempt; a newer retry may still succeed.
    const latest = effect.attempts.at(-1) === attempt;
    if (effect.status !== "intended" && (outcome === "succeeded" || latest)) effect.status = outcome;
    return ok(copy(effect));
  }

  /** Take ownership at a new epoch. In-flight effects become outcome-unknown and are returned. */
  recover(epoch: number): EffectRecord[] {
    this.fence(epoch);
    const unknown: EffectRecord[] = [];
    for (const effect of this.#effects.values()) {
      if (effect.status !== "dispatched") continue;
      effect.status = "outcome_unknown";
      for (const a of effect.attempts) if (a.status === "dispatched") a.status = "unknown";
      unknown.push(copy(effect));
    }
    return unknown;
  }

  /** Record what the target says actually happened to an outcome-unknown effect. */
  reconcile(effectId: string, observed: "applied" | "not_applied" | "failed", epoch: number): Result<EffectRecord, LedgerError> {
    if (epoch !== this.#epoch) return stale(epoch, this.#epoch);
    const effect = this.#effects.get(effectId);
    if (!effect) return err("unknown_effect", `no effect ${effectId}`);
    if (effect.status !== "outcome_unknown") return err("not_unknown", `${effectId} is ${effect.status}, not outcome-unknown`);
    effect.status = observed === "applied" ? "succeeded" : observed === "failed" ? "failed" : "intended";
    return ok(copy(effect));
  }

  get(effectId: string): EffectRecord | undefined {
    const effect = this.#effects.get(effectId);
    return effect && copy(effect);
  }

  list(): EffectRecord[] {
    return [...this.#effects.values()].map(copy);
  }

  toJSON(): { epoch: number; effects: EffectRecord[] } {
    return { epoch: this.#epoch, effects: this.list() };
  }

  static fromJSON(data: unknown): EffectLedger {
    if (typeof data !== "object" || data === null) throw new Error("invalid effect ledger data");
    const d = data as { epoch?: unknown; effects?: unknown };
    if (!Number.isInteger(d.epoch) || (d.epoch as number) < 1 || !Array.isArray(d.effects)) throw new Error("invalid effect ledger data");
    const ledger = new EffectLedger();
    ledger.#epoch = d.epoch as number;
    for (const e of d.effects as EffectRecord[]) ledger.#effects.set(e.effectId, copy(e));
    return ledger;
  }
}

function stale(got: number, current: number): { ok: false; error: { code: "stale_epoch"; message: string } } {
  return err("stale_epoch", `epoch ${got} is not the current epoch ${current}`);
}

function copy(e: EffectRecord | MutableEffect): MutableEffect {
  return { ...e, attempts: e.attempts.map((a) => ({ ...a })) };
}
