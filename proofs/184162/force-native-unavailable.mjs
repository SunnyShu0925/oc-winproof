// ESM preload (node --import): forces @openclaw/proc-safe/identity's
// readProcessIdentity to throw helper-unavailable. This makes the SHIPPED
// readWindowsProcessStartTimeSync take its real PowerShell/WMIC fallback —
// the exact path reached by sealed updater helpers and hosts without native
// bindings (PR #149257 preserves fallback for these). The fallback is what the
// clock-skew bug corrupts, so the proof must exercise it with real subprocesses.
export async function resolve(specifier, context, next) {
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.includes("@openclaw/proc-safe") && url.includes("identity")) {
    return {
      format: "module",
      shortCircuit: true,
      source: `
        export function readProcessIdentity(pid) {
          const e = new Error("native process identity is unavailable (forced for proof)");
          e.code = "PROC_SAFE_HELPER_UNAVAILABLE";
          throw e;
        }
        export function readProcessAncestry(pid, options) { throw new Error("unavailable"); }
        export function isSupported() { return false; }
      `,
    };
  }
  return next(url, context);
}
