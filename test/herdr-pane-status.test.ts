import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import herdrPaneStatus from "../extensions/herdr-pane-status.ts";

function harness() {
	const on = vi.fn();
	herdrPaneStatus({ on } as unknown as ExtensionAPI);
	expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
	const start = on.mock.calls[0][1];
	const setStatus = vi.fn();
	const fg = vi.fn((_color: string, text: string) => text);
	const ctx = { hasUI: true, ui: { setStatus, theme: { fg } } };
	return { start: () => start({}, ctx as unknown as ExtensionContext), ctx, setStatus, fg };
}

afterEach(() => vi.unstubAllEnvs());

describe("Herdr pane status", () => {
	it("displays the current pane ID in the footer", () => {
		vi.stubEnv("HERDR_PANE_ID", "wBR:p1");
		const { start, setStatus, fg } = harness();
		start();
		expect(fg).toHaveBeenCalledWith("accent", "herdr pane wBR:p1");
		expect(setStatus).toHaveBeenCalledWith("herdr_pane", "herdr pane wBR:p1");
	});

	it.each([undefined, ""])("clears the status when the pane ID is %s", (value) => {
		vi.stubEnv("HERDR_PANE_ID", value);
		const { start, setStatus, fg } = harness();
		start();
		expect(setStatus).toHaveBeenCalledWith("herdr_pane", undefined);
		expect(fg).not.toHaveBeenCalled();
	});

	it("does not access UI methods in headless mode", () => {
		vi.stubEnv("HERDR_PANE_ID", "wBR:p1");
		const { start, ctx, setStatus, fg } = harness();
		ctx.hasUI = false;
		start();
		expect(setStatus).not.toHaveBeenCalled();
		expect(fg).not.toHaveBeenCalled();
	});
});
