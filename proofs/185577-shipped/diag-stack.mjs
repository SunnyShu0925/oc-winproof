// DIAGNOSTIC preload for PR #185577 shipped proof.
// Logs the stack of EVERY Date.now() call to stderr so we can see what the
// settlement closure's stack actually looks like inside the bundled dist.
const realNow = Date.now;
let n = 0;
Date.now = function diagNow() {
  n += 1;
  const st = new Error().stack ?? "";
  // Print first 8 Date.now calls and any call whose stack mentions schtasks/terminate/settle
  if (n <= 8 || /settle|schtasks|terminate|probe/i.test(st)) {
    const lines = st.split("\n").slice(0, 6).join("\n   ");
    process.stderr.write(`[diag] Date.now #${n}:\n   ${lines}\n`);
  }
  return realNow();
};
process.on("exit", () => {
  process.stderr.write(`[diag] total Date.now calls: ${n}\n`);
});
