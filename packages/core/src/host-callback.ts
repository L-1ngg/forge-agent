export function freeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (value && typeof value === "object" && !ArrayBuffer.isView(value) && !seen.has(value)) {
		seen.add(value);
		for (const child of Object.values(value)) freeze(child, seen);
		Object.freeze(value);
	}
	return value;
}

export function cancellable<T>(operation: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
		if (signal.aborted) { abort(); return; }
		signal.addEventListener("abort", abort, { once: true });
		Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(
			value => { signal.removeEventListener("abort", abort); resolve(value); },
			error => { signal.removeEventListener("abort", abort); reject(error); },
		);
	});
}
