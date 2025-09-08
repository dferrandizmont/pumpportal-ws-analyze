import fs from "fs";
import path from "path";
import os from "os";
import { isMainThread, Worker, parentPort, workerData } from "worker_threads";
import { readJsonl, ensureDirSync } from "../lib/jsonl.js";
import { computeFeatures, passesRule } from "../lib/features.js";
import { parseTrackingSessions } from "./lib/tracking-parse.js";

// Usage: node scripts/analysis/backtest/backtest-strategies.js [outcomesDir] [trackingDirOrRoot] [outputDir]
// Defaults: outcomesDir=logs/summary-outcomes, trackingDirOrRoot=tracking, outputDir=backtest-output
// Notes:
// - If records contain strategyId and strategies.json exists, the script will use per-strategy logDir from strategies.json.
// - Otherwise it will read logs from the single trackingDirOrRoot.

const outcomesDir = process.argv[2] || path.join("logs", "summary-outcomes");
const trackingDirRoot = process.argv[3] || path.join("tracking");
const outputDir = process.argv[4] || path.join("backtest-output");
ensureDirSync(outputDir);
const LIMIT = parseInt(process.env.BT_LIMIT || "0", 10) || 0; // 0 = no limit
const OBJECTIVE = (process.env.BT_OBJECTIVE || "f1").toLowerCase();
const MIN_PREC = parseFloat(process.env.BT_MIN_PRECISION || "0.25");
const MIN_COVER = parseFloat(process.env.BT_MIN_COVERAGE || "0.05");

async function loadDataset() {
	const files = ["good.jsonl", "bad.jsonl", "neutral.jsonl"].map((f) => path.join(outcomesDir, f));
	const records = [];
	for (const f of files) {
		if (!fs.existsSync(f)) continue;
		const arr = await readJsonl(f);
		for (const obj of arr) records.push(obj);
	}
	return LIMIT > 0 ? records.slice(0, LIMIT) : records;
}

function keySession(startedAt, endedAt) {
	return `${startedAt || ""}|${endedAt || ""}`;
}

async function buildEarlyMetricsIndex(records) {
	// Load strategies.json if present to resolve per-strategy logDir
	let strategies = null;
	try {
		const strategiesFile = path.join(process.cwd(), "strategies.json");
		if (fs.existsSync(strategiesFile)) {
			const raw = fs.readFileSync(strategiesFile, "utf8");
			const arr = JSON.parse(raw);
			if (Array.isArray(arr)) {
				strategies = new Map(arr.map((s) => [s.id, s?.tracking?.logDir || path.join(trackingDirRoot, s.id)]));
			}
		}
	} catch {
		// ignore, fallback to single-dir mode
	}

	// Group by strategyId and token so we can use per-strategy folders when available
	const byStratToken = new Map(); // stratId|null -> Set(tokens)
	for (const r of records) {
		const token = r.tokenAddress;
		if (!token) continue;
		const sid = r.strategyId || null; // null if not present
		const key = sid || "__default__";
		if (!byStratToken.has(key)) byStratToken.set(key, new Set());
		byStratToken.get(key).add(token);
	}

	// index: strategyId|null -> token -> Map(keySession -> metrics)
	const index = new Map();

	for (const [sid, tokens] of byStratToken.entries()) {
		const dirForStrat = strategies && sid && strategies.get(sid) ? strategies.get(sid) : trackingDirRoot;
		for (const token of tokens) {
			const filePath = path.join(dirForStrat, `${token}-websocket.log`);
			const sessions = await parseTrackingSessions(filePath);
			const map = new Map();
			for (const s of sessions) {
				map.set(keySession(s.startedAt, s.endedAt), s.metrics);
			}
			if (!index.has(sid)) index.set(sid, new Map());
			index.get(sid).set(token, map);
		}
	}
	return index;
}

function toPlainEarlyIndex(index) {
	const out = {};
	for (const [sid, tokenMap] of index.entries()) {
		const sidKey = sid === null ? "__default__" : String(sid);
		out[sidKey] = {};
		for (const [token, sessMap] of tokenMap.entries()) {
			out[sidKey][token] = {};
			for (const [sessKey, metrics] of sessMap.entries()) {
				out[sidKey][token][sessKey] = metrics;
			}
		}
	}
	return out;
}

function* genStage1Rules() {
	const rMins = [0.55, 0.6, 0.65, 0.7];
	const bMins = [5, 8, 10];
	const tMins = [5, 10, 15];
	const uMins = [5, 8, 10];
	const netMins = [2, 5];
	const mcMin = [1000, 2500, 5000];
	const mcMax = [Number.POSITIVE_INFINITY, 100000];
	const uPerTradeMin = [0, 0.5, 0.7];
	const bPerUniqueMin = [0, 1.2, 1.4];
	const ageMax = [Number.POSITIVE_INFINITY, 3600];
	const volMax = [Number.POSITIVE_INFINITY, 5];

	for (const minBuyRatio of rMins)
		for (const minBuys of bMins)
			for (const minTotalTrades of tMins)
				for (const minUniqueTraders of uMins)
					for (const minNetBuys of netMins)
						for (const minMcUsd of mcMin)
							for (const maxMcUsd of mcMax)
								if (maxMcUsd > minMcUsd)
									for (const minUniquePerTrade of uPerTradeMin)
										for (const minBuysPerUnique of bPerUniqueMin)
											for (const maxAgeAtTriggerSec of ageMax)
												for (const maxMcVolatilityRatio of volMax)
													yield {
														minBuyRatio,
														minBuys,
														minTotalTrades,
														minUniqueTraders,
														minNetBuys,
														minMcUsd,
														maxMcUsd,
														minUniquePerTrade,
														minBuysPerUnique,
														maxAgeAtTriggerSec,
														maxMcVolatilityRatio,
													};
}

function* genStage2Rules() {
	const windows = [30, 60];
	const tradesMin = [0, 2, 3, 5];
	const maxPctMin = [0, 5, 10, 15, 20];
	for (const w of windows) for (const t of tradesMin) for (const p of maxPctMin) yield { windowSec: w, minTrades: t, minMaxPct: p };
}

function listStage2() {
	const arr = [];
	for (const r of genStage2Rules()) arr.push(r);
	return arr;
}

// applyStage2 handled in workers

// evaluate() replaced by worker-based evaluation

function toFixed(x, d = 4) {
	return Number.isFinite(x) ? Number(x.toFixed(d)) : 0;
}

async function main() {
	const startTs = Date.now();
	const records = await loadDataset();
	if (!records.length) {
		console.error("No hay datos en outcomes. Ejecuta split:summaries primero.");
		process.exit(1);
	}
	// Console: starting info
	const countGood = records.filter((r) => r.outcome === "good").length;
	const countBad = records.filter((r) => r.outcome === "bad").length;
	const countNeutral = records.filter((r) => r.outcome === "neutral").length;
	console.log("[Backtest] Iniciando análisis de estrategias...");
	console.log("starting backend analyze");
	console.log(
		`[Backtest] Opciones: outcomesDir='${outcomesDir}', trackingDirRoot='${trackingDirRoot}', outputDir='${outputDir}', LIMIT=${LIMIT || "0"}, OBJECTIVE='${OBJECTIVE}', MIN_PREC=${MIN_PREC}, MIN_COVER=${MIN_COVER}`
	);
	console.log(`[Backtest] Dataset: total=${records.length}, good=${countGood}, bad=${countBad}, neutral=${countNeutral}`);

	// Build multi-worker evaluation
	const earlyIndex = await buildEarlyMetricsIndex(records);
	const earlyPlain = toPlainEarlyIndex(earlyIndex);
	const stage1All = Array.from(genStage1Rules());
	const stage2All = listStage2();

	// Serialize records and early index for workers
	const dataPath = path.join(outputDir, "__mw_records.json");
	const earlyPath = path.join(outputDir, "__mw_early.json");
	fs.writeFileSync(
		dataPath,
		JSON.stringify(
			{
				records: records.map((r) => ({
					outcome: r.outcome,
					tokenAddress: r.tokenAddress,
					strategyId: r.strategyId || null,
					startedAt: r.startedAt || null,
					endedAt: r.endedAt || null,
				})),
			},
			null
		)
	);
	fs.writeFileSync(earlyPath, JSON.stringify(earlyPlain));

	// CSV stream
	const csvHeaders = [
		"minBuyRatio",
		"minBuys",
		"minTotalTrades",
		"minUniqueTraders",
		"minNetBuys",
		"minMcUsd",
		"maxMcUsd",
		"minUniquePerTrade",
		"minBuysPerUnique",
		"maxAgeAtTriggerSec",
		"maxMcVolatilityRatio",
		"windowSec",
		"minTrades",
		"minMaxPct",
		"positives",
		"goodPred",
		"badPred",
		"neutralPred",
		"precision",
		"recall",
		"f1",
		"coverage",
		"lift",
		"baseline",
		"totalGood",
		"total",
	];
	const outCsv = fs.createWriteStream(path.join(outputDir, "backtest_results.csv"), { encoding: "utf8" });
	outCsv.write(csvHeaders.join(",") + "\n");

	let WORKERS = parseInt(process.env.BT_WORKERS || "0", 10) || 0;
	if (WORKERS <= 0) WORKERS = Math.max(1, (os.cpus()?.length || 2) - 1);
	const chunkSize = Math.ceil(stage1All.length / WORKERS);

	const totalCombos = stage1All.length * stage2All.length;
	console.log(`[Backtest] Reglas: stage1=${stage1All.length}, stage2=${stage2All.length}, combos=${totalCombos.toLocaleString("es-ES")}, workers=${WORKERS}`);

	// Simple progress bar
	let processed = 0;
	let lastDraw = 0;
	function drawProgress(force = false) {
		const now = Date.now();
		if (!force && now - lastDraw < 200) return; // throttle a bit
		lastDraw = now;
		const ratio = totalCombos ? Math.min(1, processed / totalCombos) : 0;
		const width = 40;
		const filled = Math.round(ratio * width);
		const bar = "#".repeat(filled) + "-".repeat(Math.max(0, width - filled));
		const pct = (ratio * 100).toFixed(1).padStart(5);
		const elapsed = (now - startTs) / 1000;
		const rate = processed && elapsed > 0 ? processed / elapsed : 0; // combos/sec
		const remaining = Math.max(0, totalCombos - processed);
		const etaSec = rate > 0 ? remaining / rate : 0;
		const fmt = (s) => {
			if (!Number.isFinite(s)) return "?";
			if (s >= 3600) return `${Math.round(s / 3600)}h`;
			if (s >= 60) return `${Math.round(s / 60)}m`;
			return `${Math.round(s)}s`;
		};
		const line = `[${bar}] ${pct}%  ${processed.toLocaleString("es-ES")}/${totalCombos.toLocaleString("es-ES")}  ~${rate.toFixed(0)} ops/s  ETA ${fmt(etaSec)}`;
		process.stdout.write("\r" + line);
	}

	const topK = parseInt(process.env.BT_TOPK || "25", 10) || 25;
	const topF1 = [];
	const topPrecision = [];
	const topRecall = [];
	function pushTop(arr, row, keyA, keyB) {
		let i = arr.findIndex((x) => x[keyA] < row[keyA] || (x[keyA] === row[keyA] && x[keyB] < row[keyB]));
		if (i === -1) i = arr.length;
		arr.splice(i, 0, row);
		if (arr.length > topK) arr.pop();
	}

	await new Promise((resolve, reject) => {
		let finished = 0;
		for (let w = 0; w < WORKERS; w++) {
			const start = w * chunkSize;
			const end = Math.min(stage1All.length, start + chunkSize);
			const slice = stage1All.slice(start, end);
			if (!slice.length) {
				finished++;
				if (finished === WORKERS) resolve();
				continue;
			}
			const worker = new Worker(new URL(import.meta.url), {
				workerData: { dataPath, earlyPath, stage1Slice: slice, stage2List: stage2All },
			});
			worker.on("message", (msg) => {
				if (msg?.type === "batch" && Array.isArray(msg.rows)) {
					processed += msg.rows.length;
					drawProgress();
					for (const r of msg.rows) {
						const row = [
							r.minBuyRatio,
							r.minBuys,
							r.minTotalTrades,
							r.minUniqueTraders,
							r.minNetBuys,
							r.minMcUsd,
							r.maxMcUsd,
							r.minUniquePerTrade,
							r.minBuysPerUnique,
							r.maxAgeAtTriggerSec,
							r.maxMcVolatilityRatio,
							r.windowSec,
							r.minTrades,
							r.minMaxPct,
							r.positives,
							r.goodPred,
							r.badPred,
							r.neutralPred,
							toFixed(r.precision, 4),
							toFixed(r.recall, 4),
							toFixed(r.f1, 4),
							toFixed(r.coverage, 4),
							toFixed(r.lift, 4),
							toFixed(r.baseline, 4),
							r.totalGood,
							r.total,
						].join(",");
						outCsv.write(row + "\n");
						pushTop(topF1, r, "f1", "precision");
						pushTop(topPrecision, r, "precision", "recall");
						pushTop(topRecall, r, "recall", "precision");
					}
				} else if (msg?.type === "done") {
					finished++;
					if (finished === WORKERS) resolve();
				}
			});
			worker.on("error", reject);
			worker.on("exit", (code) => {
				if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
			});
		}
	});
	// Ensure progress bar completes and move to next line
	drawProgress(true);
	process.stdout.write("\n");
	outCsv.end();

	const pickTop = (arr, n = 25) =>
		arr.slice(0, n).map((r) => ({
			...r,
			precision: toFixed(r.precision, 4),
			recall: toFixed(r.recall, 4),
			f1: toFixed(r.f1, 4),
			coverage: toFixed(r.coverage, 4),
			lift: toFixed(r.lift, 4),
		}));

	fs.writeFileSync(path.join(outputDir, "backtest_top_f1.json"), JSON.stringify(pickTop(topF1, 50), null, 2));
	fs.writeFileSync(path.join(outputDir, "backtest_top_precision.json"), JSON.stringify(pickTop(topPrecision, 50), null, 2));
	fs.writeFileSync(path.join(outputDir, "backtest_top_recall.json"), JSON.stringify(pickTop(topRecall, 50), null, 2));

	// Pick recommended rule based on objective
	let recommended = topF1[0] || null;
	if (OBJECTIVE === "precision") {
		recommended = topPrecision.find((r) => r.coverage >= MIN_COVER) || topPrecision[0] || null;
	} else if (OBJECTIVE === "recall") {
		recommended = topRecall[0] || null;
	} else if (OBJECTIVE === "recall_min_precision") {
		const filt = topRecall.filter((r) => r.precision >= MIN_PREC);
		recommended = (filt.length ? filt[0] : topRecall[0]) || null;
	}
	if (recommended) {
		fs.writeFileSync(path.join(outputDir, "recommended_backtest_rule.json"), JSON.stringify(recommended, null, 2));
	}

	// Build HTML report
	const counts = {
		total: records.length,
		good: records.filter((r) => r.outcome === "good").length,
		bad: records.filter((r) => r.outcome === "bad").length,
		neutral: records.filter((r) => r.outcome === "neutral").length,
	};
	const html = buildBacktestHtml({
		counts,
		baseline: counts.total ? counts.good / counts.total : 0,
		topF1: pickTop(topF1, 25),
		topPrecision: pickTop(topPrecision, 25),
		topRecall: pickTop(topRecall, 25),
		recommended,
	});
	fs.writeFileSync(path.join(outputDir, "backtest-report.html"), html, "utf8");

	const totalSec = ((Date.now() - startTs) / 1000).toFixed(1);
	console.log(`[Backtest] Completado en ${totalSec}s.`);
	console.log(`Resultados: ${path.join(outputDir, "backtest_results.csv")}`);
	console.log(`Top F1/Precision/Recall en JSON en ${outputDir}`);
	if (recommended) console.log("Regla recomendada (" + OBJECTIVE + "):", recommended);
}

if (isMainThread) {
	main().catch((e) => {
		console.error("Error en backtest:", e);
		process.exit(1);
	});
} else {
	// Worker thread entry: compute evaluation for a slice of stage1 rules
	(async function workerMain() {
		try {
			const { dataPath, earlyPath, stage1Slice, stage2List } = workerData;
			const recRaw = fs.readFileSync(dataPath, "utf8");
			const { records } = JSON.parse(recRaw);
			const earlyPlain = JSON.parse(fs.readFileSync(earlyPath, "utf8"));
			const BATCH = 2000;

			function getEarlyMetrics(rec) {
				const sidKey = rec.strategyId ? String(rec.strategyId) : "__default__";
				const tokenMap = earlyPlain[sidKey] && earlyPlain[sidKey][rec.tokenAddress];
				if (!tokenMap) return null;
				const k = `${rec.startedAt || ""}|${rec.endedAt || ""}`;
				return tokenMap[k] || null;
			}

			function applyStage2Local(metrics, stage2) {
				if (!stage2) return true;
				const { windowSec, minTrades, minMaxPct } = stage2;
				if (!metrics) return minTrades <= 0 && minMaxPct <= 0;
				const trades = windowSec === 30 ? metrics.trades_30s : metrics.trades_60s;
				const maxPct = windowSec === 30 ? metrics.maxPct_30s : metrics.maxPct_60s;
				return trades >= minTrades || maxPct >= minMaxPct;
			}

			function evalCombo(stage1, stage2) {
				let positives = 0,
					goodPred = 0,
					badPred = 0,
					neutralPred = 0,
					totalGood = 0,
					total = records.length;
				for (const r of records) {
					if (r.outcome === "good") totalGood++;
					const f = computeFeatures(r);
					if (!passesRule(f, stage1)) continue;
					const m = getEarlyMetrics(r);
					if (!applyStage2Local(m, stage2)) continue;
					positives++;
					if (r.outcome === "good") goodPred++;
					else if (r.outcome === "bad") badPred++;
					else neutralPred++;
				}
				const precision = positives ? goodPred / positives : 0;
				const recall = totalGood ? goodPred / totalGood : 0;
				const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
				const coverage = total ? positives / total : 0;
				const baseline = totalGood / total;
				const lift = baseline > 0 ? precision / baseline : 0;
				return { positives, goodPred, badPred, neutralPred, precision, recall, f1, coverage, baseline, lift, totalGood, total };
			}

			let batch = [];
			for (const s1 of stage1Slice) {
				for (const s2 of stage2List) {
					const m = evalCombo(s1, s2);
					batch.push({ ...s1, ...s2, ...m });
					if (batch.length >= BATCH) {
						parentPort.postMessage({ type: "batch", rows: batch });
						batch = [];
					}
				}
			}
			if (batch.length) parentPort.postMessage({ type: "batch", rows: batch });
			parentPort.postMessage({ type: "done" });
		} catch (e) {
			parentPort.postMessage({ type: "error", error: String(e && e.stack ? e.stack : e) });
			process.exit(1);
		}
	})();
}

// ---------------- HTML helpers ----------------
function htmlesc(s) {
	if (s === null || s === undefined) return "";
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function fmtNum(x, d = 2) {
	return Number.isFinite(x) ? new Intl.NumberFormat("es-ES", { maximumFractionDigits: d, minimumFractionDigits: 0 }).format(x) : "";
}
function fmtPct(x, d = 2) {
	if (!Number.isFinite(x)) return "";
	const v = x * 100;
	return `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: d, minimumFractionDigits: 0 }).format(v)}%`;
}
function envNumInt(x) {
	return Number.isFinite(x) ? String(Math.round(x)) : "";
}
function envNumDec(x, d = 2) {
	return Number.isFinite(x)
		? Number(x)
				.toFixed(d)
				.replace(/\.0+$/, "")
				.replace(/(\.[0-9]*?)0+$/, "$1")
		: "";
}

function renderRuleCard(rule, title, id, recommended = false) {
	if (!rule) return `<div class="muted">No disponible</div>`;
	const conds = [
		`buyRatio ≥ ${fmtNum(rule.minBuyRatio, 2)}`,
		`preBuys ≥ ${fmtNum(rule.minBuys, 0)}`,
		`preTotalTrades ≥ ${fmtNum(rule.minTotalTrades, 0)}`,
		`preUniqueTraders ≥ ${fmtNum(rule.minUniqueTraders, 0)}`,
		`netBuys ≥ ${fmtNum(rule.minNetBuys, 0)}`,
		`${fmtNum(rule.minMcUsd, 0)} ≤ entryMarketCapUsd ≤ ${rule.maxMcUsd === Infinity ? "∞" : fmtNum(rule.maxMcUsd, 0)}`,
		rule.minUniquePerTrade ? `uniquePerTrade ≥ ${fmtNum(rule.minUniquePerTrade, 2)}` : null,
		rule.minBuysPerUnique ? `buysPerUnique ≥ ${fmtNum(rule.minBuysPerUnique, 2)}` : null,
		rule.maxMcVolatilityRatio !== Infinity ? `mcVolRatio ≤ ${fmtNum(rule.maxMcVolatilityRatio, 2)}` : null,
		rule.maxAgeAtTriggerSec !== Infinity ? `ageAtTriggerSec ≤ ${fmtNum(rule.maxAgeAtTriggerSec, 0)}` : null,
	].filter(Boolean);

	const stage2 = [`windowSec = ${envNumInt(rule.windowSec)}`, `minTrades = ${envNumInt(rule.minTrades)}`, `minMaxPct = ${envNumInt(rule.minMaxPct)}`];

	const env = [
		`TRACK_FILTERS_ENABLED=true`,
		`TRACK_ALL_MINTS=false`,
		`TRACK_MIN_BUYS=${envNumInt(rule.minBuys)}`,
		`TRACK_MIN_TOTAL_TRADES=${envNumInt(rule.minTotalTrades)}`,
		`TRACK_MIN_UNIQUE_TRADERS=${envNumInt(rule.minUniqueTraders)}`,
		`TRACK_MIN_BUY_RATIO=${envNumDec(rule.minBuyRatio, 2)}`,
		`TRACK_MIN_NET_BUYS=${envNumInt(rule.minNetBuys)}`,
		`TRACK_MIN_MC_USD=${envNumInt(rule.minMcUsd)}`,
		`TRACK_MAX_MC_USD=${rule.maxMcUsd === Infinity ? "" : envNumInt(rule.maxMcUsd)}`,
		`TRACK_MIN_UNIQUE_PER_TRADE=${rule.minUniquePerTrade ? envNumDec(rule.minUniquePerTrade, 2) : 0}`,
		`TRACK_MIN_BUYS_PER_UNIQUE=${rule.minBuysPerUnique ? envNumDec(rule.minBuysPerUnique, 2) : 0}`,
		`TRACK_MAX_AGE_AT_TRIGGER_SEC=${rule.maxAgeAtTriggerSec === Infinity ? "" : envNumInt(rule.maxAgeAtTriggerSec)}`,
		`TRACK_MAX_MC_VOLATILITY_RATIO=${rule.maxMcVolatilityRatio === Infinity ? "" : envNumDec(rule.maxMcVolatilityRatio, 2)}`,
		`TRACK_STAGE2_ENABLED=true`,
		`TRACK_STAGE2_WINDOW_SEC=${envNumInt(rule.windowSec)}`,
		`TRACK_STAGE2_MIN_TRADES=${envNumInt(rule.minTrades)}`,
		`TRACK_STAGE2_MIN_MAXPCT=${envNumInt(rule.minMaxPct)}`,
	].join("\n");

	return `
		<div class="card">
			<h3>${htmlesc(title)}${recommended ? ' <span class="badge rec">Recomendado</span>' : ""}</h3>
			<div class="value small metrics">precision ${fmtPct(rule.precision)} · recall ${fmtPct(rule.recall)} · F1 ${fmtPct(rule.f1)} · coverage ${fmtPct(rule.coverage)} · lift ${fmtNum(rule.lift, 2)}</div>
			<div class="small"><div>Condiciones Etapa 1:</div><div class="cond-badges">${conds.map((c) => `<span class="cond">${htmlesc(c)}</span>`).join("")}</div></div>
			<div class="small" style="margin-top:8px;"><div>Confirmación Etapa 2:</div><div class="cond-badges">${stage2.map((c) => `<span class="cond">${htmlesc(c)}</span>`).join("")}</div></div>
			<div class="small" style="margin-top:10px;">
				<div>Sugerencia .env (copiar/pegar):</div>
				<code id="${htmlesc(id)}" style="display:block; white-space:pre; margin-top:6px;">${htmlesc(env)}</code>
				<button class="copy-btn" data-target="${htmlesc(id)}">Copiar</button>
			</div>
		</div>
	`;
}

function buildBacktestHtml({ counts, baseline, topF1, topPrecision, topRecall, recommended }) {
	const css = `
	:root { --bg:#eceff4; --panel:#fff; --panel-alt:#fff; --border:#d8dee9; --text:#2e3440; --muted:#4c566a; --heading:#2e3440; --code-bg:#e5e9f0; --good:#a3be8c; --bad:#bf616a; --neutral:#81a1c1; --accent:#5e81ac; --shadow:rgba(0,0,0,.06); --badge-bg:#e5e9f0; }
	:root[data-theme='dark'] { --bg:#1e1e2e; --panel:#181825; --panel-alt:#11111b; --border:#313244; --text:#cdd6f4; --muted:#a6adc8; --heading:#cdd6f4; --code-bg:#313244; --good:#a6e3a1; --bad:#f38ba8; --neutral:#b4befe; --accent:#89b4fa; --shadow:rgba(0,0,0,.5); --badge-bg:#313244; }
	*{box-sizing:border-box} body{font-family:'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace;margin:0;color:var(--text);background:var(--bg);} .container{width:100%;max-width:100%;padding:16px}
	header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:16px} h1{margin:0;font-size:24px;color:var(--heading)} .toolbar{display:flex;gap:12px;align-items:center}
	.badge{border:1px solid var(--border);padding:6px 10px;border-radius:999px;background:var(--panel);color:var(--text)} .badge.rec{border-color:var(--accent);color:var(--accent);margin-left:8px}
	.card{border:1px solid var(--border);border-radius:12px;padding:12px 14px;background:var(--panel);box-shadow:0 6px 18px var(--shadow);margin-bottom:10px}
	.metrics{margin:8px 0 10px;line-height:1.6} .cond-badges{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px} .cond{border:1px dashed var(--border);padding:6px 10px;border-radius:10px;background:var(--badge-bg)}
	.copy-btn{margin-top:6px;border:1px solid var(--border);background:var(--panel);color:var(--text);padding:6px 10px;border-radius:8px;cursor:pointer} .copy-btn:hover{background:var(--badge-bg)}
	.panel{border:1px solid var(--border);border-radius:12px;padding:14px;background:var(--panel-alt)} .grid{display:grid;grid-template-columns:1fr;gap:12px} @media(min-width:1100px){.grid{grid-template-columns:1fr 1fr 1fr}}
	.muted{color:var(--muted)} code{background:var(--code-bg);padding:4px 6px;border-radius:6px;border:1px solid var(--border)}
	table{border-collapse:separate;border-spacing:0;width:100%;border:1px solid var(--border);border-radius:12px;overflow:hidden}
	th,td{padding:8px 10px;text-align:right} thead th{background:var(--badge-bg);position:sticky;top:0;z-index:1} td.label,th.label{text-align:left}
	`;

	function renderTable(rows, title) {
		const header = `
			<tr>
				<th class="label">Regla</th>
				<th>minBuyRatio</th><th>minBuys</th><th>minTrades</th><th>minUnique</th><th>minNetBuys</th><th>minMcUsd</th><th>maxMcUsd</th>
				<th>minUnique/Trade</th><th>minBuys/Unique</th><th>maxAgeSec</th><th>maxMcVolRatio</th>
				<th>winSec</th><th>minTrades</th><th>minMaxPct</th>
				<th>precision</th><th>recall</th><th>F1</th><th>coverage</th><th>lift</th><th>positives</th><th>goodPred</th><th>neutralPred</th><th>badPred</th>
			</tr>`;
		const body = rows
			.map(
				(r, i) => `
			<tr>
				<td class="label">#${i + 1}</td>
				<td>${fmtNum(r.minBuyRatio, 2)}</td><td>${fmtNum(r.minBuys, 0)}</td><td>${fmtNum(r.minTotalTrades, 0)}</td><td>${fmtNum(r.minUniqueTraders, 0)}</td><td>${fmtNum(r.minNetBuys, 0)}</td>
				<td>${fmtNum(r.minMcUsd, 0)}</td><td>${r.maxMcUsd === Infinity ? "&infin;" : fmtNum(r.maxMcUsd, 0)}</td>
				<td>${fmtNum(r.minUniquePerTrade, 2)}</td><td>${fmtNum(r.minBuysPerUnique, 2)}</td><td>${r.maxAgeAtTriggerSec === Infinity ? "&infin;" : fmtNum(r.maxAgeAtTriggerSec, 0)}</td><td>${r.maxMcVolatilityRatio === Infinity ? "&infin;" : fmtNum(r.maxMcVolatilityRatio, 2)}</td>
				<td>${fmtNum(r.windowSec, 0)}</td><td>${fmtNum(r.minTrades, 0)}</td><td>${fmtNum(r.minMaxPct, 0)}</td>
				<td>${fmtPct(r.precision)}</td><td>${fmtPct(r.recall)}</td><td>${fmtPct(r.f1)}</td><td>${fmtPct(r.coverage)}</td><td>${fmtNum(r.lift, 2)}</td><td>${fmtNum(r.positives, 0)}</td><td>${fmtNum(r.goodPred, 0)}</td><td>${fmtNum(r.neutralPred, 0)}</td><td>${fmtNum(r.badPred, 0)}</td>
			</tr>`
			)
			.join("");
		return `<div class="panel"><h2>${htmlesc(title)}</h2><div class="table-wrap"><table>${header}${body}</table></div></div>`;
	}

	const recCard = renderRuleCard(recommended, "Regla recomendada", "rec", true);
	const topF1Table = renderTable(topF1, "Top 25 por F1");
	const topPrecisionTable = renderTable(topPrecision, "Top 25 por Precisión");
	const topRecallTable = renderTable(topRecall, "Top 25 por Recall");

	const tp = recommended ? recommended.goodPred : 0;
	const fp = recommended ? recommended.positives - recommended.goodPred : 0;
	const fn = recommended ? recommended.totalGood - recommended.goodPred : 0;
	const fpNeutral = recommended ? recommended.neutralPred : 0;
	const fpBad = recommended ? recommended.badPred : 0;

	const filesLinks = `
		<div class="badges">
			<a class="badge" href="backtest_results.csv">backtest_results.csv</a>
			<a class="badge" href="backtest_top_f1.json">backtest_top_f1.json</a>
			<a class="badge" href="backtest_top_precision.json">backtest_top_precision.json</a>
			<a class="badge" href="backtest_top_recall.json">backtest_top_recall.json</a>
			<a class="badge" href="recommended_backtest_rule.json">recommended_backtest_rule.json</a>
		</div>`;

	return `<!doctype html><html lang="es"><head>
	<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
	<title>Backtest de Estrategias</title>
	<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
	<style>${css}</style></head>
	<body><div class="container">
	<header><h1>Backtest de Estrategias</h1><div class="toolbar"><span class="badge">Baseline: ${fmtPct(baseline)}</span><button class="theme-toggle" id="themeToggle">Tema: <span id="themeLabel">Claro</span></button></div></header>
	<div class="cards"><div class="card"><h3>Total</h3><div class="value">${fmtNum(counts.total)}</div></div><div class="card"><h3 class="good">Good</h3><div class="value good">${fmtNum(counts.good)}</div></div><div class="card"><h3 class="neutral">Neutral</h3><div class="value neutral">${fmtNum(counts.neutral)}</div></div><div class="card"><h3 class="bad">Bad</h3><div class="value bad">${fmtNum(counts.bad)}</div></div></div>
	<div class="panel"><h2>Archivos</h2>${filesLinks}</div>
	<div class="panel"><h2>Regla recomendada</h2>${recCard}<div class="muted" style="margin-top:8px;">Matriz de confusión aprox: TP ${fmtNum(tp)}, FP ${fmtNum(fp)} (neutrales ${fmtNum(fpNeutral)}, bad ${fmtNum(fpBad)}), FN ${fmtNum(fn)}.</div></div>
	${topF1Table}${topPrecisionTable}${topRecallTable}
	</div>
	<script>(function(){const r=document.documentElement,b=document.getElementById('themeToggle'),l=document.getElementById('themeLabel');function a(t){if(t==='dark'){r.setAttribute('data-theme','dark');l.textContent='Oscuro';}else{r.removeAttribute('data-theme');l.textContent='Claro';}localStorage.setItem('btTheme',t);}a(localStorage.getItem('btTheme')||'light');b.addEventListener('click',()=>{const c=r.getAttribute('data-theme')==='dark'?'dark':'light';a(c==='dark'?'light':'dark');});})();(function(){document.querySelectorAll('.copy-btn').forEach(btn=>{btn.addEventListener('click',async()=>{const id=btn.getAttribute('data-target');const code=document.getElementById(id);if(!code)return;try{await navigator.clipboard.writeText(code.innerText);const o=btn.textContent;btn.textContent='Copiado!';setTimeout(()=>btn.textContent=o,1500);}catch(e){console.error('Copy failed',e);}});});})();</script>
	</body></html>`;
}
