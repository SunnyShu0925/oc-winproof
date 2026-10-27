// DIAGNOSTIC preload for PR #185577 shipped proof.
// Logs the stack AND value of every Date.now() call whose stack falls inside
// the settlement region (service-state chunk / schtasks-state-probe.ts), so we
// can see whether the pre-fix deadline/remaining actually collapsed and whether
// the deadline-exceeded check fired. Run with a pre-fix build to observe the bug.
const realNow = Date.now;
const shiftMs = Number(process.env.PROOF_SHIFT_MS ?? "0");
let n = 0;
let settlementSeed = null; // real wall time of the settlement deadline seed

const settlementPatterns = [
  "service-state-",
  "schtasks-state-probe.ts",
  "prepareScheduledTaskSettlement",
  "ScheduledTaskSettlement",
];

function shortFrame(stack) {
  const lines = stack.split("\n");
  for (let i = 2; i < lines.length && i < 5; i++) {
    const l = lines[i].trim();
    if (l && !l.includes("diag-stack.mjs")) return l;
  }
  return "";
}

Date.now = function diagSettlementNow() {
  const now = realNow();
  n += 1;
  let stack = "";
  try {
    stack = new Error().stack ?? "";
  } catch {
    stack = "";
  }
  if (!settlementPatterns.some((p) => stack.includes(p))) {
    return now;
  }
  const frame = shortFrame(stack);
  const shifted = now + shiftMs;
  let note = "";
  if (settlementSeed === null) {
    settlementSeed = now;
    note = "SEED(real)";
  } else {
    note = "stepped";
  }
  process.stderr.write(
    `[diag-settle] #${n} ${note} frame=[${frame}]\n` +
      `   real=${now} shifted=${shifted} seed=${settlementSeed}\n`,
  );
  // Return real for the seed (deadline base), shifted for every later read so we
  // observe the collapse exactly like the real clock-step injection does.
  return note === "SEED(real)" ? now : shifted;
};

process.on("exit", () => {
  process.stderr.write(`[diag-settle] total Date.now calls: ${n}\n`);
});
