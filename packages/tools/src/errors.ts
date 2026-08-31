export type ToolErrorCode =
	| "INVALID_ARGUMENT"
	| "PATH_NOT_FOUND"
	| "PATH_IS_DIRECTORY"
	| "PARENT_NOT_FOUND"
	| "ALREADY_EXISTS"
	| "PERMISSION_DENIED"
	| "IO_ERROR"
	| "EDIT_NOT_FOUND"
	| "EDIT_AMBIGUOUS"
	| "COMMAND_FAILED"
	| "COMMAND_TIMEOUT"
	| "ABORTED";

export interface ToolError {
	error_code: ToolErrorCode;
	message: string;
	field: string;
	expected: string;
	example: string;
	retryable: boolean;
}

export type ToolOutcome<T> = { ok: true; value: T } | { ok: false; error: ToolError };

export function toolError(
	error_code: ToolErrorCode,
	message: string,
	field: string,
	expected: string,
	example: string,
	retryable = false,
): ToolOutcome<never> {
	return { ok: false, error: { error_code, message, field, expected, example, retryable } };
}

export function fileError(
	error: unknown,
	field: string,
	expected: string,
	example: string,
): ToolOutcome<never> {
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
	if (code === "ENOENT") return toolError("PATH_NOT_FOUND", "Path does not exist", field, expected, example);
	if (code === "EACCES" || code === "EPERM") {
		return toolError("PERMISSION_DENIED", "Permission denied", field, expected, example);
	}
	return toolError("IO_ERROR", error instanceof Error ? error.message : "File operation failed", field, expected, example, true);
}
