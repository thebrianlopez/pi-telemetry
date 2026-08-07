/**
 * Mock Pi event objects.
 *
 * Shapes are derived from the upstream Pi source of truth,
 * `packages/coding-agent/src/core/extensions/types.ts` and
 * `packages/ai/src/types.ts` — NOT from the TDD prose, which described an
 * `args`/`result` surface that does not exist on `ToolResultEvent`.
 *
 *   ToolCallEventBase   { type, toolCallId, toolName, input }
 *   ToolResultEventBase { type, toolCallId, toolName, input, content, isError, usage?, details }
 *   AgentEndEvent       { type, messages }
 *   ModelSelectEvent    { type, model, previousModel, source }
 *   Usage               { input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning? }
 */

export function textContent(text: string) {
	return { type: "text" as const, text };
}

export function bashToolCall(command: string, toolCallId = "tc-1") {
	return {
		type: "tool_call" as const,
		toolCallId,
		toolName: "bash" as const,
		input: { command },
	};
}

export function fileToolCall(
	toolName: "edit" | "write" | "read",
	input: Record<string, unknown>,
	toolCallId = "tc-1",
) {
	return { type: "tool_call" as const, toolCallId, toolName, input };
}

export function bashToolResult(
	command: string,
	output: string,
	isError = false,
	toolCallId = "tc-1",
) {
	return {
		type: "tool_result" as const,
		toolCallId,
		toolName: "bash" as const,
		input: { command },
		content: [textContent(output)],
		isError,
		details: undefined,
	};
}

export function assistantMessage(
	usage: Partial<{
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	}> = {},
) {
	return {
		role: "assistant" as const,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			...usage,
		},
	};
}

export function userMessage() {
	return { role: "user" as const, content: "hello" };
}
