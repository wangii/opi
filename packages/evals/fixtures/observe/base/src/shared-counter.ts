const counters = new Map<string, number>();

export function increment(key: string): number {
	const current = counters.get(key) ?? 0;
	const next = current + 1;
	counters.set(key, next);
	return next;
}

export function reset(): void {
	counters.clear();
}
