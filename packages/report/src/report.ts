import type { ClimbRound, Trial } from "@harness/ir";

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
}

export function trialsJsonl(round: ClimbRound, trials: readonly Trial[]): string {
  const header = {
    accepted: round.accepted,
    impermissible: round.train.impermissible,
    overrefusal: round.train.overrefusal,
    testImpermissible: round.test.impermissible,
    testOverrefusal: round.test.overrefusal,
  };
  return `${[JSON.stringify(header), ...trials.map((trial) => JSON.stringify(trial))].join("\n")}\n`;
}

export function reportHtml(round: ClimbRound): string {
  if (!round.accepted && round.reason === undefined) throw new Error("rejected round needs a reason");
  const status = round.accepted ? "accepted" : `rejected: ${round.reason}`;
  const body = [
    `<p>${escapeHtml(status)}</p>`,
    `<p>impermissible ${round.train.impermissible} ${round.test.impermissible}</p>`,
    `<p>overrefusal ${round.train.overrefusal} ${round.test.overrefusal}</p>`,
  ].join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>eval</title></head><body>${body}</body></html>`;
}
