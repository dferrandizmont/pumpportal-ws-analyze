import fs from "fs";
import path from "path";
import { readJsonl, ensureDirSync, writeCsv } from "./lib/jsonl.js";
import { computeFeatures, passesRule } from "./lib/features.js";
import { quantile } from "./lib/stats.js";

// Usage: node scripts/analysis/analyze-good-predictors.js [outcomesDir] [outputDir]
// Defaults: outcomesDir=logs/summary-outcomes, outputDir=analysis-output

const outcomesDir = process.argv[2] || path.join("logs", "summary-outcomes");
const outputDir = process.argv[3] || path.join("analysis-output");

ensureDirSync(outputDir);

async function loadDataset() {
	const files = [
		{ file: path.join(outcomesDir, "good.jsonl"), outcome: "good" },
		{ file: path.join(outcomesDir, "bad.jsonl"), outcome: "bad" },
		{ file: path.join(outcomesDir, "neutral.jsonl"), outcome: "neutral" },
	];

	const records = [];
	for (const f of files) {
		if (!fs.existsSync(f.file)) continue;
		const arr = await readJsonl(f.file);
		for (const obj of arr) records.push(obj);
	}

	const feats = records.map(computeFeatures);
	return feats;
}

function byOutcome(feats) {
	const g = [];
	const b = [];
	const n = [];
	for (const f of feats) {
		if (f.outcome === "good") g.push(f);
		else if (f.outcome === "bad") b.push(f);
		else n.push(f);
	}
	return { good: g, bad: b, neutral: n };
}

function describeField(arr, field) {
	const vals = arr.map((x) => x[field]).filter((v) => Number.isFinite(v));
	vals.sort((a, b) => a - b);
	if (!vals.length) {
		return { count: 0 };
	}
	return {
		count: vals.length,
		min: vals[0],
		p25: quantile(vals, 0.25),
		median: quantile(vals, 0.5),
		p75: quantile(vals, 0.75),
		max: vals[vals.length - 1],
	};
}

function summarize(feats) {
	const groups = byOutcome(feats);
	const fields = [
		"preTotalTrades",
		"preBuys",
		"preSells",
		"preUniqueTraders",
		"buyRatio",
		"netBuys",
		"uniquePerTrade",
		"buysPerUnique",
		"tradesPerUnique",
		"mcPerUnique",
		"deltaBuys",
		"deltaSells",
		"deltaTrades",
		"deltaUnique",
		"accelBuys",
		"accelTrades",
		"accelUnique",
		"volatilityAbs",
		"volatilityRatio",
		"imbalancePerTrade",
		"entryMarketCapUsd",
		"entryMarketCapSol",
		"ageAtTriggerSec",
	];

	const rows = [];
	for (const field of fields) {
		for (const outcome of ["good", "bad", "neutral"]) {
			const stats = describeField(groups[outcome], field);
			rows.push({ outcome, field, ...stats });
		}
	}
	return rows;
}

function* genRules() {
	// Reduced core search space + extra feature thresholds
	const rMins = [0.55, 0.65, 0.75];
	const bMins = [5, 8, 12];
	const tMins = [5, 10, 15];
	const uMins = [5, 8, 12];
	const netMins = [2, 5];
	const mcMin = [1000, 5000];
	const mcMax = [Number.POSITIVE_INFINITY, 100000];

	const uniquePerTradeMin = [0, 0.5, 0.7];
	const buysPerUniqueMin = [0, 1.2, 1.5];
	const deltaBuysMin = [0, 1, 3];
	const volatilityRatioMax = [Number.POSITIVE_INFINITY, 5];
	const ageMax = [Number.POSITIVE_INFINITY, 3600]; // <= 1h

	for (const minBuyRatio of rMins)
		for (const minBuys of bMins)
			for (const minTotalTrades of tMins)
				for (const minUniqueTraders of uMins)
					for (const minNetBuys of netMins)
						for (const minMcUsd of mcMin)
							for (const maxMcUsd of mcMax)
								if (maxMcUsd > minMcUsd)
									for (const minUniquePerTrade of uniquePerTradeMin)
										for (const minBuysPerUnique of buysPerUniqueMin)
											for (const minDeltaBuys of deltaBuysMin)
												for (const maxVolatilityRatio of volatilityRatioMax)
													for (const maxAgeAtTriggerSec of ageMax)
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
															minDeltaBuys,
															maxVolatilityRatio,
															maxAgeAtTriggerSec,
														};
}

function evaluateRules(feats) {
	const total = feats.length;
	const totalGood = feats.filter((f) => f.outcome === "good").length;
	const baseline = totalGood / total;
	const results = [];

	for (const rule of genRules()) {
		let positives = 0;
		let goodPred = 0;
		for (const f of feats) {
			const pass = passesRule(f, rule);
			if (pass) {
				positives++;
				if (f.outcome === "good") goodPred++;
			}
		}

		if (positives === 0) continue;

		const precision = goodPred / positives;
		const recall = totalGood ? goodPred / totalGood : 0;
		const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
		const coverage = positives / total;
		const lift = baseline > 0 ? precision / baseline : 0;

		results.push({
			...rule,
			positives,
			goodPred,
			precision,
			recall,
			f1,
			coverage,
			lift,
			baseline,
		});
	}

	results.sort((a, b) => b.f1 - a.f1 || b.precision - a.precision || b.recall - a.recall);
	return { baseline, results };
}

function toFixed(x, d = 4) {
	return Number.isFinite(x) ? Number(x.toFixed(d)) : null;
}

// Machine-friendly number formatters for .env snippets (no grouping, dot decimal)
function envNumInt(x) {
	if (!Number.isFinite(x)) return "";
	return String(Math.round(x));
}
function envNumDec(x, digits = 2) {
	if (!Number.isFinite(x)) return "";
	return Number(x)
		.toFixed(digits)
		.replace(/\.0+$/, "")
		.replace(/(\.[0-9]*?)0+$/, "$1");
}

async function main() {
	const feats = await loadDataset();
	if (!feats.length) {
		console.error("No hay datos para analizar. Ejecuta primero el splitter.");
		process.exit(1);
	}

	// 1) Resumen descriptivo por outcome
	const summaryRows = summarize(feats);
	writeCsv(path.join(outputDir, "summary_stats.csv"), summaryRows, ["outcome", "field", "count", "min", "p25", "median", "p75", "max"]);

	// 2) Búsqueda de umbrales para reglas simples
	const { baseline, results } = evaluateRules(feats);
	const top = results.slice(0, 100);

	// Select best rules for different objectives
	const bestF1 = results[0] || null;
	const bestPrecision = results.slice().sort((a, b) => b.precision - a.precision || b.recall - a.recall)[0] || null;
	const bestRecall = results.slice().sort((a, b) => b.recall - a.recall || b.precision - a.precision)[0] || null;

	// Guardar búsqueda completa y top
	writeCsv(
		path.join(outputDir, "threshold_search.csv"),
		results.map((r) => ({
			...r,
			precision: toFixed(r.precision, 4),
			recall: toFixed(r.recall, 4),
			f1: toFixed(r.f1, 4),
			coverage: toFixed(r.coverage, 4),
			lift: toFixed(r.lift, 4),
			baseline: toFixed(r.baseline, 4),
		})),
		[
			"minBuyRatio",
			"minBuys",
			"minTotalTrades",
			"minUniqueTraders",
			"minNetBuys",
			"minMcUsd",
			"maxMcUsd",
			"positives",
			"goodPred",
			"precision",
			"recall",
			"f1",
			"coverage",
			"lift",
			"baseline",
		]
	);

	writeCsv(
		path.join(outputDir, "threshold_top100.csv"),
		top.map((r) => ({
			...r,
			precision: toFixed(r.precision, 4),
			recall: toFixed(r.recall, 4),
			f1: toFixed(r.f1, 4),
			coverage: toFixed(r.coverage, 4),
			lift: toFixed(r.lift, 4),
			baseline: toFixed(r.baseline, 4),
		})),
		[
			"minBuyRatio",
			"minBuys",
			"minTotalTrades",
			"minUniqueTraders",
			"minNetBuys",
			"minMcUsd",
			"maxMcUsd",
			"positives",
			"goodPred",
			"precision",
			"recall",
			"f1",
			"coverage",
			"lift",
			"baseline",
		]
	);

	const recommended = bestF1 || null;
	if (recommended) {
		fs.writeFileSync(path.join(outputDir, "recommended_rule.json"), JSON.stringify(recommended, null, 2));
	}

	// 3) Reporte HTML detallado
	const html = buildHtmlReport({
		feats,
		summaryRows,
		baseline,
		results,
		top: top.slice(0, 25),
		recommended,
		bestPrecision,
		bestRecall,
		outputDir,
	});
	fs.writeFileSync(path.join(outputDir, "report.html"), html, "utf8");

	console.log("Análisis completado.");
	console.log(`Baseline good-rate: ${toFixed(baseline, 4)}`);
	if (recommended) {
		console.log("Mejor regla (top por F1):", recommended);
	}
	console.log(`Reportes en: ${outputDir}`);
}

main().catch((err) => {
	console.error("Error en análisis:", err);
	process.exit(1);
});

// ---------------- HTML report helpers -----------------

function htmlesc(s) {
	if (s === null || s === undefined) return "";
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtNum(x, digits = 2) {
	if (!Number.isFinite(x)) return "";
	return new Intl.NumberFormat("es-ES", {
		maximumFractionDigits: digits,
		minimumFractionDigits: 0,
	}).format(x);
}

function fmtPct(x, digits = 2) {
	if (!Number.isFinite(x)) return "";
	const val = x * 100;
	return `${new Intl.NumberFormat("es-ES", {
		maximumFractionDigits: digits,
		minimumFractionDigits: 0,
	}).format(val)}%`;
}

function buildHtmlReport({ feats, summaryRows, baseline, top, recommended, bestPrecision, bestRecall, _outputDir }) {
	const counts = {
		total: feats.length,
		good: feats.filter((f) => f.outcome === "good").length,
		bad: feats.filter((f) => f.outcome === "bad").length,
		neutral: feats.filter((f) => f.outcome === "neutral").length,
	};

	const css = `
  /* Light theme (Nord-like) + Dark theme (Catppuccin Mocha) with theme switch */
  :root {
    /* Core */
    --polar-night-0: #2e3440;
    --polar-night-1: #3b4252;
    --polar-night-2: #434c5e;
    --polar-night-3: #4c566a;
    --snow-storm-0: #eceff4; /* light bg */
    --snow-storm-1: #e5e9f0;
    --snow-storm-2: #d8dee9; /* borders/code bg */
    --frost-0: #8fbcbb;
    --frost-1: #88c0d0;
    --frost-2: #81a1c1;
    --frost-3: #5e81ac;
    --aurora-red: #bf616a;
    --aurora-orange: #d08770;
    --aurora-yellow: #ebcb8b;
    --aurora-green: #a3be8c;
    --aurora-purple: #b48ead;

    --bg: var(--snow-storm-0);
    --panel: #ffffff;
    --panel-alt: #ffffff;
    --border: var(--snow-storm-2);
    --text: var(--polar-night-0);
    --muted: var(--polar-night-3);
    --heading: var(--polar-night-0);
    --code-bg: var(--snow-storm-1);
    --good: var(--aurora-green);
    --bad: var(--aurora-red);
    --neutral: var(--frost-2);
    --accent: var(--frost-3);
    --accent-2: var(--frost-1);
    --accent-3: var(--aurora-yellow);
    --shadow: rgba(0,0,0,0.06);
    /* Table and chip colors (light) */
    --table-head-bg: var(--snow-storm-1);
    --table-head-text: var(--polar-night-3);
    --table-row-odd-bg: #ffffff;
    --table-row-even-bg: var(--snow-storm-0);
    --table-row-hover-bg: var(--snow-storm-1);
    --badge-bg: var(--snow-storm-1);
  }

  :root[data-theme='dark'] {
    /* Catppuccin Mocha */
    --bg: #1e1e2e;          /* base */
    --panel: #181825;       /* mantle */
    --panel-alt: #11111b;   /* crust */
    --border: #313244;      /* surface0 */
    --text: #cdd6f4;        /* text */
    --muted: #a6adc8;       /* subtext0 */
    --heading: #cdd6f4;     /* text */
    --code-bg: #313244;     /* surface0 */
    --good: #a6e3a1;        /* green */
    --bad: #f38ba8;         /* red */
    --neutral: #b4befe;     /* lavender */
    --accent: #89b4fa;      /* blue */
    --accent-2: #cba6f7;    /* mauve */
    --accent-3: #fab387;    /* peach */
    --shadow: rgba(0,0,0,0.5);
    /* Table and chip colors (dark) */
    --table-head-bg: #313244;     /* surface0 */
    --table-head-text: #cdd6f4;   /* text */
    --table-row-odd-bg: #1e1e2e;  /* base */
    --table-row-even-bg: #181825; /* mantle */
    --table-row-hover-bg: #313244;/* surface0 */
    --badge-bg: #313244;          /* surface0 */
  }

  * { box-sizing: border-box; }
  body {
    font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
    margin: 0; color: var(--text);
    background: var(--bg);
  }
  .container { width: 100%; max-width: 100%; margin: 0 auto; padding: 16px; }
  header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 16px; }
  h1 { font-size: 26px; margin: 0; color: var(--heading); }
  h2 { font-size: 20px; margin: 24px 0 8px; color: var(--heading); }
  h3 { font-size: 16px; margin: 12px 0 8px; color: var(--heading); }
  .muted { color: var(--muted); }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; margin: 12px 0 20px; }
  .card { border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; background: var(--panel); box-shadow: 0 6px 18px var(--shadow); }
  .card h3 { margin: 0 0 10px; font-size: 13px; color: var(--subtext1); font-weight: 700; letter-spacing: .3px; }
  .card .value { font-size: 20px; font-weight: 700; color: var(--text); }
  .metrics { margin: 8px 0 10px; line-height: 1.6; }
  .conditions { margin-top: 8px; }
  .conditions code { display: block; margin-top: 6px; padding: 8px 10px; white-space: normal; word-break: break-word; }
  .badges { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .toolbar { display: flex; gap: 12px; align-items: center; }
  .theme-toggle { border: 1px solid var(--border); border-radius: 999px; padding: 6px 10px; background: var(--panel); color: var(--text); cursor: pointer; box-shadow: 0 2px 10px var(--shadow); }
  .badge { font-size: 12px; border: 1px solid var(--border); padding: 6px 10px; border-radius: 999px; background: var(--panel); color: var(--text); box-shadow: 0 2px 10px var(--shadow); }
  .badge.good { border-color: var(--good); background: var(--badge-bg); color: var(--good); }
  .badge.bad { border-color: var(--bad); background: var(--badge-bg); color: var(--bad); }
  .badge.neutral { border-color: var(--neutral); background: var(--badge-bg); color: var(--neutral); }
  .cond-badges { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
  .cond { font-size: 12px; border: 1px dashed var(--border); padding: 8px 12px; border-radius: 10px; background: var(--badge-bg); color: var(--text); box-shadow: 0 1px 6px var(--shadow); }
  .copy-btn { margin-top: 6px; border: 1px solid var(--border); background: var(--panel); color: var(--text); padding: 6px 10px; border-radius: 8px; cursor: pointer; }
  .copy-btn:hover { background: var(--badge-bg); }
  .panel { border: 1px solid var(--border); border-radius: 12px; padding: 14px; background: var(--panel-alt); box-shadow: 0 6px 18px var(--shadow); }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  .table-wrap { width: 100%; overflow-x: auto; }
  table { border-collapse: separate; border-spacing: 0; width: 100%; margin: 10px 0 20px; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; box-shadow: 0 6px 18px var(--shadow); }
  th, td { padding: 10px 12px; text-align: right; }
  thead th { background: var(--table-head-bg); color: var(--table-head-text); position: sticky; top: 0; z-index: 1; font-size: 12px; text-transform: uppercase; letter-spacing: .5px; }
  tbody tr:nth-child(odd) { background: var(--table-row-odd-bg); }
  tbody tr:nth-child(even) { background: var(--table-row-even-bg); }
  tbody tr:hover { background: var(--table-row-hover-bg); }
  td.label, th.label { text-align: left; }
  .good { color: var(--good); }
  .bad { color: var(--bad); }
  .neutral { color: var(--neutral); }
  code { background: var(--code-bg); color: var(--text); padding: 4px 6px; border-radius: 6px; border: 1px solid var(--border); }
  .small { font-size: 12px; }
  .section { margin-top: 16px; }
  .grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
  @media (min-width: 900px) { .grid { grid-template-columns: 1fr 1fr; } }
  @media (min-width: 1300px) { .grid { grid-template-columns: 1fr 1fr 1fr; } }
  .legend { font-size: 13px; line-height: 1.7; }
  .legend ul { margin: 8px 0 12px; padding-left: 20px; }
  .legend li { margin: 6px 0; }
  .spacer { height: 8px; }
  `;

	const filesLinks = `
    <div class="badges">
      <a class="badge" href="summary_stats.csv">summary_stats.csv</a>
      <a class="badge" href="threshold_search.csv">threshold_search.csv</a>
      <a class="badge" href="threshold_top100.csv">threshold_top100.csv</a>
      <a class="badge" href="recommended_rule.json">recommended_rule.json</a>
    </div>
  `;

	// Build descriptive stats by field
	const fields = Array.from(new Set(summaryRows.map((r) => r.field)));
	const statsTables = fields
		.map((field) => {
			const rows = summaryRows.filter((r) => r.field === field);
			const header = `
        <tr>
          <th class="label">Outcome</th>
          <th>Count</th><th>Min</th><th>P25</th><th>Median</th><th>P75</th><th>Max</th>
        </tr>`;
			const body = ["good", "bad", "neutral"]
				.map((o) => rows.find((r) => r.outcome === o) || { outcome: o })
				.map(
					(r) => `
          <tr>
            <td class="label ${htmlesc(r.outcome)}">${htmlesc(r.outcome)}</td>
            <td>${fmtNum(r.count)}</td>
            <td>${fmtNum(r.min)}</td>
            <td>${fmtNum(r.p25)}</td>
            <td>${fmtNum(r.median)}</td>
            <td>${fmtNum(r.p75)}</td>
            <td>${fmtNum(r.max)}</td>
          </tr>`
				)
				.join("");
			return `
        <div class="panel">
          <h3>${htmlesc(field)}</h3>
          <div class="table-wrap">
          <table class="sortable">
            ${header}
            ${body}
          </table>
          </div>
        </div>`;
		})
		.join("\n");

	// Top rules table
	const topRulesTable = (() => {
		const header = `
      <tr>
        <th class="label">Rule</th>
        <th>minBuyRatio</th><th>minBuys</th><th>minTrades</th><th>minUnique</th><th>minNetBuys</th><th>minMcUsd</th><th>maxMcUsd</th>
        <th>minUnique/Trade</th><th>minBuys/Unique</th><th>minΔBuys</th><th>maxMcVolRatio</th><th>maxAgeSec</th>
        <th>precision</th><th>recall</th><th>F1</th><th>coverage</th><th>lift</th><th>positives</th><th>goodPred</th>
      </tr>`;
		const body = top
			.map(
				(r, i) => `
        <tr>
          <td class="label">#${i + 1}</td>
          <td>${fmtNum(r.minBuyRatio, 2)}</td>
          <td>${fmtNum(r.minBuys, 0)}</td>
          <td>${fmtNum(r.minTotalTrades, 0)}</td>
          <td>${fmtNum(r.minUniqueTraders, 0)}</td>
          <td>${fmtNum(r.minNetBuys, 0)}</td>
          <td>${fmtNum(r.minMcUsd, 0)}</td>
          <td>${r.maxMcUsd === Infinity ? "&infin;" : fmtNum(r.maxMcUsd, 0)}</td>
          <td>${fmtNum(r.minUniquePerTrade, 2)}</td>
          <td>${fmtNum(r.minBuysPerUnique, 2)}</td>
          <td>${fmtNum(r.minDeltaBuys, 0)}</td>
          <td>${r.maxVolatilityRatio === Infinity ? "&infin;" : fmtNum(r.maxVolatilityRatio, 2)}</td>
          <td>${r.maxAgeAtTriggerSec === Infinity ? "&infin;" : fmtNum(r.maxAgeAtTriggerSec, 0)}</td>
          <td>${fmtPct(r.precision)}</td>
          <td>${fmtPct(r.recall)}</td>
          <td>${fmtPct(r.f1)}</td>
          <td>${fmtPct(r.coverage)}</td>
          <td>${fmtNum(r.lift, 2)}</td>
          <td>${fmtNum(r.positives, 0)}</td>
          <td>${fmtNum(r.goodPred, 0)}</td>
        </tr>`
			)
			.join("");
		return `<div class="table-wrap"><table class="sortable">${header}${body}</table></div>`;
	})();

	function renderRuleCard(rule, title) {
		if (!rule) return '<div class="muted">No disponible</div>';
		const conds = [
			`buyRatio ≥ ${fmtNum(rule.minBuyRatio, 2)}`,
			`preBuys ≥ ${fmtNum(rule.minBuys, 0)}`,
			`preTotalTrades ≥ ${fmtNum(rule.minTotalTrades, 0)}`,
			`preUniqueTraders ≥ ${fmtNum(rule.minUniqueTraders, 0)}`,
			`netBuys ≥ ${fmtNum(rule.minNetBuys, 0)}`,
			`${fmtNum(rule.minMcUsd, 0)} ≤ entryMarketCapUsd ≤ ${rule.maxMcUsd === Infinity ? "∞" : fmtNum(rule.maxMcUsd, 0)}`,
		];
		if (rule.minUniquePerTrade && rule.minUniquePerTrade > 0) conds.push(`uniquePerTrade ≥ ${fmtNum(rule.minUniquePerTrade, 2)}`);
		if (rule.minBuysPerUnique && rule.minBuysPerUnique > 0) conds.push(`buysPerUnique ≥ ${fmtNum(rule.minBuysPerUnique, 2)}`);
		if (rule.minDeltaBuys && rule.minDeltaBuys > 0) conds.push(`Δbuys ≥ ${fmtNum(rule.minDeltaBuys, 0)}`);
		if (rule.maxVolatilityRatio !== undefined && rule.maxVolatilityRatio !== Infinity) conds.push(`mcVolRatio ≤ ${fmtNum(rule.maxVolatilityRatio, 2)}`);
		if (rule.maxAgeAtTriggerSec !== undefined && rule.maxAgeAtTriggerSec !== Infinity) conds.push(`ageAtTriggerSec ≤ ${fmtNum(rule.maxAgeAtTriggerSec, 0)}`);
		const condBadges = conds.map((c) => `<span class="cond">${htmlesc(c)}</span>`).join("\n");

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
			`TRACK_MAX_MC_VOLATILITY_RATIO=${rule.maxVolatilityRatio === Infinity ? "" : envNumDec(rule.maxVolatilityRatio, 2)}`,
		].join("\n");

		const codeId = `env-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
		const isRecommended = /recomendada|recomendada|máx f1/i.test(title);
		return `
          <div class="card">
            <h3>${htmlesc(title)}${isRecommended ? ' <span class="badge rec">Recomendado</span>' : ""}</h3>
            <div class="value small metrics">
              precision ${fmtPct(rule.precision)} · recall ${fmtPct(rule.recall)} · F1 ${fmtPct(rule.f1)} · coverage ${fmtPct(rule.coverage)} · lift ${fmtNum(rule.lift, 2)}
            </div>
            <div class="small conditions">
              <div>Condiciones:</div>
              <div class="cond-badges">${condBadges}</div>
            </div>
            <div class="small" style="margin-top:10px;">
              <div>Sugerencia .env (copiar/pegar, con decimales en punto):</div>
              <code id="${codeId}" style="display:block; white-space:pre; margin-top:6px;">${htmlesc(env)}</code>
              <button class="copy-btn" data-target="${codeId}">Copiar</button>
            </div>
          </div>
        `;
	}

	const recBlock = renderRuleCard(recommended, "Regla recomendada (máx F1)");
	const bestPrecisionBlock = renderRuleCard(bestPrecision, "Máxima precisión");
	const bestRecallBlock = renderRuleCard(bestRecall, "Máximo recall");

	const html = `<!doctype html>
  <html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Reporte de Análisis: Predictoras de GOOD</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
    <style>${css}</style>
  </head>
  <body>
    <div class="container">
      <header>
        <h1>Reporte de Análisis: Predictoras de “GOOD”</h1>
        <div class="toolbar">
          <span class="badge">Baseline: ${fmtPct(baseline)}</span>
          <button class="theme-toggle" id="themeToggle">Tema: <span id="themeLabel">Claro</span></button>
        </div>
      </header>

      <div class="cards">
        <div class="card"><h3>Total registros</h3><div class="value">${fmtNum(counts.total)}</div></div>
        <div class="card"><h3 class="good">Good</h3><div class="value good">${fmtNum(counts.good)}</div></div>
        <div class="card"><h3 class="bad">Bad</h3><div class="value bad">${fmtNum(counts.bad)}</div></div>
        <div class="card"><h3 class="neutral">Neutral</h3><div class="value neutral">${fmtNum(counts.neutral)}</div></div>
      </div>

      <div class="section panel">
        <h2>Cómo interpretar las métricas</h2>
        <div class="legend">
          <div>• <b>Baseline</b>: proporción de “good” en todo el dataset.</div>
          <div>• <b>Positives</b>: registros que cumplen la regla.</div>
          <div>• <b>GoodPred</b>: de esos positivos, cuántos son “good”.</div>
          <div>• <b>Precisión</b>: GoodPred / Positives.</div>
          <div>• <b>Recall</b>: GoodPred / Total Good.</div>
          <div>• <b>F1</b>: media armónica de precisión y recall.</div>
          <div>• <b>Coverage</b>: Positives / Total registros.</div>
          <div>• <b>Lift</b>: Precisión / Baseline (x veces mejor que azar).</div>
        </div>
      </div>

      <div class="section">
        <h2>Archivos generados</h2>
        ${filesLinks}
      </div>

      <div class="section panel">
        <h2>Cómo leer este reporte</h2>
        <div class="legend">
          <div><b>Objetivo:</b> encontrar condiciones (umbrales) sobre métricas previas que elevan la probabilidad de que un token sea <span class="good">GOOD</span>.</div>
          <div><b>Campos importantes:</b>
            <ul>
              <li><code>preTotalTrades</code>: nº de trades previos al disparo.</li>
              <li><code>preBuys</code> / <code>preSells</code>: nº de compras/ventas previas.</li>
              <li><code>preUniqueTraders</code>: nº de traders únicos previos.</li>
              <li><code>buyRatio</code>: preBuys / (preBuys + preSells).</li>
              <li><code>netBuys</code>: preBuys − preSells.</li>
              <li><code>uniquePerTrade</code>: preUniqueTraders / preTotalTrades.</li>
              <li><code>buysPerUnique</code>: preBuys / preUniqueTraders.</li>
              <li><code>tradesPerUnique</code>: preTotalTrades / preUniqueTraders.</li>
              <li><code>mcPerUnique</code>: entryMarketCapUsd / preUniqueTraders.</li>
              <li><code>Δbuys/Δsells/Δtrades/Δunique</code>: diferencia vs métricas preEntry.</li>
              <li><code>accel*</code>: cociente vs preEntry (crecimiento relativo).</li>
              <li><code>mcVolRatio</code>: preEntryMaxMcUsd / preEntryMinMcUsd.</li>
              <li><code>imbalancePerTrade</code>: netBuys / preTotalTrades.</li>
              <li><code>entryMarketCapUsd</code>: market cap de entrada (USD).</li>
              <li><code>ageAtTriggerSec</code>: antigüedad del token al disparo.</li>
            </ul>
          </div>
          <div><b>Cómo interpretar las métricas de regla:</b>
            <ul>
              <li><b>Baseline</b>: % de GOOD sin filtrar (referencia).</li>
              <li><b>Precision</b>: de lo que seleccionas, qué % es GOOD.</li>
              <li><b>Recall</b>: de todos los GOOD, qué % capturas.</li>
              <li><b>F1</b>: equilibrio entre precision y recall.</li>
              <li><b>Coverage</b>: % del dataset que pasa la regla.</li>
              <li><b>Lift</b>: multiplicador vs Baseline (x veces mejor que azar).</li>
            </ul>
          </div>
          <div><b>Guía rápida:</b>
            <ul>
              <li><i>Más precisión</i>: sube <code>buyRatio</code>, <code>preUniqueTraders</code> y <code>preBuys</code>.</li>
              <li><i>Más recall</i>: baja levemente los mínimos o amplia <code>maxMcUsd</code>.</li>
              <li><i>Evitar extremos</i>: usa rango de <code>entryMarketCapUsd</code> (p. ej., ≥ 1k y ≤ 100k).</li>
            </ul>
          </div>
        </div>
      </div>

      <div class="section panel">
        <h2>Presets de reglas</h2>
        ${recBlock}
        <div class="spacer"></div>
        ${bestPrecisionBlock}
        <div class="spacer"></div>
        ${bestRecallBlock}
      </div>

      <div class="section panel">
        <h2>Top 25 reglas por F1</h2>
        ${topRulesTable}
        <div class="small muted">Sugerencia: prioriza precisión si quieres menos falsos positivos; prioriza recall si quieres capturar más “good”.</div>
      </div>

      <div class="section">
        <h2>Estadística descriptiva por outcome</h2>
        <p class="muted">Para cada métrica: count, min, P25, mediana, P75, max por outcome.</p>
        <div class="grid">
          ${statsTables}
        </div>
      </div>
    </div>

    <script>
      // Theme switch (Nord light/dark) persisted in localStorage
      (function(){
        const root = document.documentElement;
        const btn = document.getElementById('themeToggle');
        const label = document.getElementById('themeLabel');
        function apply(theme){
          if(theme === 'dark') { root.setAttribute('data-theme','dark'); label.textContent = 'Oscuro'; }
          else { root.removeAttribute('data-theme'); label.textContent = 'Claro'; }
          localStorage.setItem('reportTheme', theme);
        }
        const saved = localStorage.getItem('reportTheme') || 'light';
        apply(saved);
        btn.addEventListener('click', () => {
          const current = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
          apply(current === 'dark' ? 'light' : 'dark');
        });
      })();

      // Copy buttons for env snippets
      (function(){
        document.querySelectorAll('.copy-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-target');
            const code = document.getElementById(id);
            if (!code) return;
            try {
              await navigator.clipboard.writeText(code.innerText);
              const old = btn.textContent;
              btn.textContent = 'Copied!';
              setTimeout(()=>{ btn.textContent = old; }, 1500);
            } catch (e) {
              console.error('Copy failed', e);
            }
          });
        });
      })();

      // Copy buttons for env snippets
      (function(){
        document.querySelectorAll('.copy-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-target');
            const code = document.getElementById(id);
            if (!code) return;
            try {
              await navigator.clipboard.writeText(code.innerText);
              const old = btn.textContent;
              btn.textContent = 'Copied!';
              setTimeout(()=>{ btn.textContent = old; }, 1500);
            } catch (e) { console.error('Copy failed', e); }
          });
        });
      })();

      // Simple sort for tables with class="sortable" (supports es-ES numbers)
      (function(){
        function parseCell(text){
          const t = text.trim().replace(/%$/, '');
          // Convert es-ES format (1.234,56) -> 1234.56
          const cleaned = t.replace(/[.]/g, '').replace(/,/g, '.');
          const n = Number(cleaned);
          return Number.isFinite(n) ? n : text.toLowerCase();
        }
        document.querySelectorAll('table.sortable thead th').forEach((th, idx) => {
          th.style.cursor = 'pointer';
          th.addEventListener('click', () => {
            const table = th.closest('table');
            const rows = Array.from(table.querySelectorAll('tbody tr'));
            const asc = th.dataset.sort !== 'asc';
            rows.sort((a,b) => {
              const A = parseCell(a.children[idx].textContent);
              const B = parseCell(b.children[idx].textContent);
              if (A < B) return asc ? -1 : 1;
              if (A > B) return asc ? 1 : -1;
              return 0;
            });
            table.querySelector('thead th[data-sort]')?.removeAttribute('data-sort');
            th.dataset.sort = asc ? 'asc' : 'desc';
            const tbody = table.querySelector('tbody');
            rows.forEach(r => tbody.appendChild(r));
          });
        });
      })();
    </script>
  </body>
  </html>`;
	return html;
}
