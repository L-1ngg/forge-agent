import { McpError } from "./types.ts";
/** Settle the caller on cancellation. The original promise retains ownership of
 * any native write/lock until its real outcome is known; this is not rollback. */
export function awaitMcpOperation<T>(operation: Promise<T>, signal: AbortSignal, code = "canceled"): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(new McpError(code, code === "credential-outcome-unknown" ? "Credential operation canceled before its outcome was confirmed; transaction ownership is retained until settlement" : "MCP operation canceled or expired"));
		if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
