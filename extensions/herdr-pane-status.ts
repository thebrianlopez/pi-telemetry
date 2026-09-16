import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		const paneId = process.env.HERDR_PANE_ID;
		ctx.ui.setStatus(
			"herdr_pane",
			paneId ? ctx.ui.theme.fg("accent", `pane ${paneId}`) : undefined,
		);
	});
}
