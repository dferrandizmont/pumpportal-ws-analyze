export function isFiniteNumber(x) {
	return typeof x === "number" && Number.isFinite(x);
}

export function filterNumbers(arr) {
	return arr.filter(isFiniteNumber);
}

export function mean(arr) {
	const a = filterNumbers(arr);
	if (!a.length) return NaN;
	return a.reduce((s, v) => s + v, 0) / a.length;
}

export function variance(arr) {
	const a = filterNumbers(arr);
	if (a.length < 2) return NaN;
	const m = mean(a);
	const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
	return v;
}

export function stddev(arr) {
	const v = variance(arr);
	return Number.isNaN(v) ? NaN : Math.sqrt(v);
}

export function quantile(arr, q) {
	const a = filterNumbers(arr).sort((x, y) => x - y);
	if (!a.length) return NaN;
	if (q <= 0) return a[0];
	if (q >= 1) return a[a.length - 1];
	const idx = (a.length - 1) * q;
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return a[lo];
	const h = idx - lo;
	return a[lo] * (1 - h) + a[hi] * h;
}

export function describe(arr) {
	const a = filterNumbers(arr);
	return {
		count: a.length,
		mean: mean(a),
		std: stddev(a),
		min: a.length ? a[0] : NaN,
		p25: quantile(a, 0.25),
		median: quantile(a, 0.5),
		p75: quantile(a, 0.75),
		max: a.length ? a[a.length - 1] : NaN,
	};
}
