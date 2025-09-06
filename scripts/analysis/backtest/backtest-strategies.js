import fs from "fs";
import path from "path";
import { readJsonl, ensureDirSync, writeCsv } from "../lib/jsonl.js";
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

function applyStage2(metrics, stage2) {
	if (!stage2) return true;
	const { windowSec, minTrades, minMaxPct } = stage2;
	if (!metrics) return minTrades <= 0 && minMaxPct <= 0; // missing metrics only pass if thresholds are 0
	const trades = windowSec === 30 ? metrics.trades_30s : metrics.trades_60s;
	const maxPct = windowSec === 30 ? metrics.maxPct_30s : metrics.maxPct_60s;
	return trades >= minTrades || maxPct >= minMaxPct;
}

function evaluate(records, earlyIndex, stage1, stage2) {
	let positives = 0,
		goodPred = 0,
		badPred = 0,
		neutralPred = 0,
		totalGood = 0,
		total = records.length;

	for (const r of records) {
		if (r.outcome === "good") totalGood++;
		const f = computeFeatures(r);
		const pass1 = passesRule(f, stage1);
		if (!pass1) continue;
		// Resolve early metrics map by strategyId (if available) and token
		const stratMap = earlyIndex.get(r.strategyId || null);
		const tokenMap = stratMap ? stratMap.get(r.tokenAddress) : null;
		const m = tokenMap ? tokenMap.get(keySession(r.startedAt, r.endedAt)) : null;
		const pass2 = applyStage2(m, stage2);
		if (!pass2) continue;
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

function toFixed(x, d = 4) {
	return Number.isFinite(x) ? Number(x.toFixed(d)) : 0;
}

async function main() {
	const records = await loadDataset();
	if (!records.length) {
		console.error("No hay datos en outcomes. Ejecuta split:summaries primero.");
		process.exit(1);
	}
	const earlyIndex = await buildEarlyMetricsIndex(records);

	const results = [];
	for (const s1 of genStage1Rules()) {
		for (const s2 of genStage2Rules()) {
			const m = evaluate(records, earlyIndex, s1, s2);
			results.push({ ...s1, ...s2, ...m });
		}
	}

	// Orderings
	const byF1 = results.slice().sort((a, b) => b.f1 - a.f1 || b.precision - a.precision);
	const byPrecision = results.slice().sort((a, b) => b.precision - a.precision || b.recall - a.recall);
	const byRecall = results.slice().sort((a, b) => b.recall - a.recall || b.precision - a.precision);

	// Persist CSV
	writeCsv(
		path.join(outputDir, "backtest_results.csv"),
		results.map((r) => ({
			...r,
			precision: toFixed(r.precision, 4),
			recall: toFixed(r.recall, 4),
			f1: toFixed(r.f1, 4),
			coverage: toFixed(r.coverage, 4),
			lift: toFixed(r.lift, 4),
		})),
		[
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
		]
	);

	const pickTop = (arr, n = 25) =>
		arr.slice(0, n).map((r) => ({
			...r,
			precision: toFixed(r.precision, 4),
			recall: toFixed(r.recall, 4),
			f1: toFixed(r.f1, 4),
			coverage: toFixed(r.coverage, 4),
			lift: toFixed(r.lift, 4),
		}));

	fs.writeFileSync(path.join(outputDir, "backtest_top_f1.json"), JSON.stringify(pickTop(byF1, 50), null, 2));
	fs.writeFileSync(path.join(outputDir, "backtest_top_precision.json"), JSON.stringify(pickTop(byPrecision, 50), null, 2));
	fs.writeFileSync(path.join(outputDir, "backtest_top_recall.json"), JSON.stringify(pickTop(byRecall, 50), null, 2));

	// Pick recommended rule based on objective
	let recommended = byF1[0] || null;
	if (OBJECTIVE === "precision") {
		recommended = byPrecision.find((r) => r.coverage >= MIN_COVER) || byPrecision[0] || null;
	} else if (OBJECTIVE === "recall") {
		recommended = byRecall[0] || null;
	} else if (OBJECTIVE === "recall_min_precision") {
		const filt = byRecall.filter((r) => r.precision >= MIN_PREC);
		recommended = (filt.length ? filt[0] : byRecall[0]) || null;
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
		topF1: pickTop(byF1, 25),
		topPrecision: pickTop(byPrecision, 25),
		topRecall: pickTop(byRecall, 25),
		recommended,
	});
	fs.writeFileSync(path.join(outputDir, "backtest-report.html"), html, "utf8");

	console.log("Backtest completado.");
	console.log(`Resultados: ${path.join(outputDir, "backtest_results.csv")}`);
	console.log(`Top F1/Precision/Recall en JSON en ${outputDir}`);
	if (recommended) console.log("Regla recomendada (" + OBJECTIVE + "):", recommended);
}

main().catch((e) => {
	console.error("Error en backtest:", e);
	process.exit(1);
});

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
