import fs from "fs";
import readline from "readline";

// Parse a per-token tracking log file and extract sessions with early-window metrics
// A session is assumed to start when the first 'Current price:' line appears after a previous summary
// and ends at the JSON summary line (INFO {"type":"summary", ...}).

const CURRENT_REGEX = /Current price:\s*([^\s]+)\s*-\s*Current percentage:\s*([-0-9.]+)%.*?Trading time:\s*(\d+):(\d+):(\d+)/;
const SUMMARY_JSON_START = /\{\s*"type"\s*:\s*"summary"/;

function toSec(h, m, s) {
	return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10);
}

function computeEarlyMetrics(points, winSec) {
	const within = points.filter((p) => p.t <= winSec);
	if (!within.length) {
		return { trades: 0, maxPct: 0, minPct: 0 };
	}
	return {
		trades: within.length,
		maxPct: within.reduce((mx, p) => (p.pct > mx ? p.pct : mx), -Infinity),
		minPct: within.reduce((mn, p) => (p.pct < mn ? p.pct : mn), Infinity),
	};
}

export async function parseTrackingSessions(filePath) {
	if (!fs.existsSync(filePath)) return [];
	const rl = readline.createInterface({
		input: fs.createReadStream(filePath, { encoding: "utf8" }),
		crlfDelay: Infinity,
	});

	const sessions = [];
	let cur = null; // { points: [{t,pct}], startedAt?, endedAt? }

	for await (const line of rl) {
		if (!line) continue;
		const m = line.match(CURRENT_REGEX);
		if (m) {
			if (!cur) cur = { points: [] };
			const pct = parseFloat(m[2]);
			const t = toSec(m[3], m[4], m[5]);
			if (Number.isFinite(pct) && Number.isFinite(t)) {
				cur.points.push({ t, pct });
			}
			continue;
		}

		const sidx = line.indexOf("{");
		if (sidx !== -1) {
			const trailer = line.slice(sidx);
			if (SUMMARY_JSON_START.test(trailer)) {
				try {
					const obj = JSON.parse(trailer);
					// Close current session and attach summary times
					if (!cur) cur = { points: [] };
					cur.startedAt = obj.startedAt || null;
					cur.endedAt = obj.endedAt || null;

					const m30 = computeEarlyMetrics(cur.points, 30);
					const m60 = computeEarlyMetrics(cur.points, 60);

					sessions.push({
						startedAt: cur.startedAt,
						endedAt: cur.endedAt,
						points: cur.points,
						metrics: {
							trades_30s: m30.trades,
							trades_60s: m60.trades,
							maxPct_30s: Number.isFinite(m30.maxPct) ? m30.maxPct : 0,
							maxPct_60s: Number.isFinite(m60.maxPct) ? m60.maxPct : 0,
							minPct_30s: Number.isFinite(m30.minPct) ? m30.minPct : 0,
							minPct_60s: Number.isFinite(m60.minPct) ? m60.minPct : 0,
						},
					});
					cur = null; // reset after summary
				} catch {
					// ignore parse errors
				}
			}
		}
	}

	return sessions;
}
