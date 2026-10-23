import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SOURCE = "pi-telemetry-model";
const TOKEN = "pi_model";
const TTL_MS = 12 * 60 * 60 * 1000;

type Run = (file: string, args: readonly string[]) => void;

/** Run a Herdr metadata write without involving a shell or blocking Pi's lifecycle. */
export function runHerdr(file: string, args: readonly string[]): void {
	execFile(file, [...args], { timeout: 5_000 }, () => {
		// Presentation metadata is best-effort. Herdr being absent or restarting must never affect Pi.
	});
}

export function modelLabel(model: unknown): string | null {
	if (model === null || typeof model !== "object") return null;
	const candidate = model as { provider?: unknown; id?: unknown };
	if (typeof candidate.provider !== "string" || typeof candidate.id !== "string") return null;
	const provider = candidate.provider.trim();
	const id = candidate.id.trim();
	if (!provider || !id) return null;
	const label = `${provider}/${id}`;
	return label.length <= 80 && !/[\u0000-\u001f\u007f]/u.test(label) ? label : null;
}

export function reportModel(
	paneId: string | undefined,
	label: string,
	run: Run = runHerdr,
	herdrBin = process.env.HERDR_BIN_PATH || process.env.HERDR_BIN || "herdr",
): void {
	if (!paneId) return;
	run(herdrBin, [
		"pane",
		"report-metadata",
		paneId,
		"--source",
		SOURCE,
		"--agent",
		"pi",
		"--token",
		`${TOKEN}=${label}`,
		"--ttl-ms",
		String(TTL_MS),
	]);
}

export function clearModel(
	paneId: string | undefined,
	run: Run = runHerdr,
	herdrBin = process.env.HERDR_BIN_PATH || process.env.HERDR_BIN || "herdr",
): void {
	if (!paneId) return;
	run(herdrBin, [
		"pane",
		"report-metadata",
		paneId,
		"--source",
		SOURCE,
		"--agent",
		"pi",
		"--clear-token",
		TOKEN,
	]);
}

export default function (pi: ExtensionAPI) {
	let current: string | null = null;
	const paneId = process.env.HERDR_PANE_ID;

	const publish = (model: unknown, ctx: { ui: { setStatus(key: string, text: string | undefined): void } }) => {
		const label = modelLabel(model);
		if (label === null) return;
		current = label;
		ctx.ui.setStatus("model", label);
		reportModel(paneId, label);
	};

	pi.on("session_start", async (_event, ctx) => publish(ctx.model, ctx));
	pi.on("model_select", async (event, ctx) => publish(event.model, ctx));

	// Refresh the crash-safety TTL during active sessions without producing metadata churn while idle.
	pi.on("turn_start", async () => {
		if (current !== null) reportModel(paneId, current);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("model", undefined);
		clearModel(paneId);
	});
}
