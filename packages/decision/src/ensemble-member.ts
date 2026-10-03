/**
 * The cognitive core's ensemble as a decision `Member`. The ensemble fails over between
 * its judges, so no single model is behind it: after each call `served()` names the one
 * that answered (the ensemble says so in the `x-harness-model` response header), at the
 * version the catalog pins it to, so records and calibration are keyed by that model and
 * not by "the ensemble".
 *
 * A model's version is the commit its weights are pinned to (the catalog's artifact
 * revision); a hosted model pins no artifact, so its catalog id stands for it. It is never
 * `latest`. The ensemble's identity itself (before any call, when nothing is served yet)
 * is the constant `ensemble`.
 */
import { MODEL_HEADER } from "@harness/cognitive";
import type { Ensemble } from "@harness/cognitive";
import { evaluationMember } from "./member.ts";
import type { Answers, Asked, Member, ModelIdentity } from "./types.ts";

/** What of the ensemble the member uses: its judge and its catalog. */
export type EnsembleLike = Pick<Ensemble, "evaluationModel" | "members">;

const ENSEMBLE_VERSION = "ensemble";

/**
 * A member that asks the ensemble's judge (all questions in one `experimental_evaluate`
 * call, no retries: the ladder passes a failing member up) and says which model answered.
 * `askWithIdentity` returns that model's id and version with the answers of the very call
 * (undefined when the response does not name its model), so a decision that asks several
 * times, or calls running at once on this shared member, each know whom they heard.
 * `served()` is only the latest call's, for status: undefined before the first call, after
 * a call that failed, and when a response does not name its model; with concurrent calls
 * it names the one that finished last, and no decision reads it.
 */
export function ensembleMember(ensemble: EnsembleLike, options: { readonly id?: string } = {}): Member {
  let latest: ModelIdentity | undefined;
  const model = ensemble.evaluationModel();
  const identity = { id: options.id ?? "ensemble", version: ENSEMBLE_VERSION };
  async function askWithIdentity(asked: Asked): Promise<{ readonly answers: Answers; readonly served: ModelIdentity | undefined }> {
    latest = undefined;
    // the model that answered this call: held here, in the call, and in no variable the calls share
    let served: ModelIdentity | undefined;
    const answers = await evaluationMember(
      {
        ...model,
        doEvaluate: async (callOptions) => {
          const result = await model.doEvaluate(callOptions);
          const id = result.response?.headers?.[MODEL_HEADER];
          served = id === undefined ? undefined : { id, version: ensemble.members().find((m) => m.id === id)?.descriptor.artifact?.revision ?? id };
          return result;
        },
      },
      identity,
    ).ask(asked);
    latest = served;
    return { answers, served };
  }
  return {
    ...identity,
    ask: async (asked) => (await askWithIdentity(asked)).answers,
    askWithIdentity,
    served: () => latest,
  };
}
