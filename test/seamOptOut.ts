/**
 * Shared opt-out for seam checks that reach outside this repository.
 *
 * A seam check compares a literal this package hard-codes against the thing
 * that literal is supposed to match in another repo. Those checks cannot run
 * where the other repo is absent. The default is to FAIL in that case: a check
 * that quietly skips reports success it did not earn, which is precisely the
 * failure mode seam checks exist to catch.
 *
 * One literal, deliberately alarming, so that `rg SEAM_CHECKS_UNVERIFIED`
 * surfaces every environment where drift detection has been switched off.
 */
export const SEAM_OPT_OUT = "SEAM_CHECKS_UNVERIFIED_I_ACCEPT_DRIFT_RISK";

export function seamChecksOptedOut(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const v = env[SEAM_OPT_OUT];
	return v === "1" || v?.toLowerCase() === "true";
}
