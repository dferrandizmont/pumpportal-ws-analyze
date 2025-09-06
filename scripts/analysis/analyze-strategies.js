import fs from "fs";
import path from "path";
import readline from "readline";
import { readJsonl, ensureDirSync, writeCsv } from "./lib/jsonl.js";

const outcomesDir = path.join("logs", "summary-outcomes");
const summariesLog = path.join("logs", "tracking-summaries.log");
const outDir = path.join("analysis-output", "strategies");
const strategiesFile = process.env.STRATEGIES_FILE || path.join(process.cwd(), "strategies.json");

async function loadFromJsonl() {
	const files = ["good.jsonl", "bad.jsonl", "neutral.jsonl"].map((f) => path.join(outcomesDir, f));
	const recs = [];
	for (const f of files) {
		if (!fs.existsSync(f)) continue;
		const arr = await readJsonl(f);
		recs.push(...arr);
	}
	return recs;
}

async function loadFromLog() {
	if (!fs.existsSync(summariesLog)) return [];
	const rl = readline.createInterface({ input: fs.createReadStream(summariesLog, { encoding: "utf8" }), crlfDelay: Infinity });
	const recs = [];
	for await (const line of rl) {
		if (!line) continue;
		const idx = line.indexOf("{");
		if (idx === -1) continue;
		const jsonStr = line.slice(idx);
		try {
			const obj = JSON.parse(jsonStr);
			if (obj && obj.type === "summary") recs.push(obj);
		} catch {
			// Ignore parsing errors
		}
	}
	return recs;
}

function analyzeByStrategy(records) {
	const marked = records.filter((r) => r && r.strategyId);
	const totalMarked = marked.length;
	const totalGoodMarked = marked.filter((r) => r.outcome === "good").length;
	const baseline = totalMarked ? totalGoodMarked / totalMarked : 0;

	const byStrat = new Map();
	for (const r of marked) {
		const id = r.strategyId;
		if (!byStrat.has(id)) byStrat.set(id, []);
		byStrat.get(id).push(r);
	}

	const rows = [];
	for (const [id, arr] of byStrat.entries()) {
		const positives = arr.length;
		const goodPred = arr.filter((r) => r.outcome === "good").length;
		const badPred = arr.filter((r) => r.outcome === "bad").length;
		const neutralPred = arr.filter((r) => r.outcome === "neutral").length;
		const uniqueTokens = new Set(arr.map((r) => r.tokenAddress)).size;

		const precision = positives ? goodPred / positives : 0;
		const recall = totalGoodMarked ? goodPred / totalGoodMarked : 0;
		const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
		const coverage = totalMarked ? positives / totalMarked : 0;
		const lift = baseline > 0 ? precision / baseline : 0;

		rows.push({
			strategyId: id,
			positives,
			uniqueTokens,
			goodPred,
			neutralPred,
			badPred,
			precision,
			recall,
			f1,
			coverage,
			lift,
			baseline,
			totalMarked,
			totalGoodMarked,
		});
	}

	rows.sort((a, b) => b.f1 - a.f1 || b.precision - a.precision);
	return { baseline, totalMarked, totalGoodMarked, rows };
}

function fmt(x, d = 4) {
	return Number.isFinite(x) ? Number(x.toFixed(d)) : 0;
}

async function main() {
	let records = [];
	if (fs.existsSync(outcomesDir)) records = await loadFromJsonl();
	if (!records.length) records = await loadFromLog();
	if (!records.length) {
		console.error("No hay datos para analizar. Ejecuta 'npm run split:summaries' o comprueba logs/tracking-summaries.log");
		process.exit(1);
	}

	const { baseline, totalMarked, totalGoodMarked, rows } = analyzeByStrategy(records);

	ensureDirSync(outDir);
	writeCsv(
		path.join(outDir, "strategy_metrics.csv"),
		rows.map((r) => ({
			...r,
			precision: fmt(r.precision),
			recall: fmt(r.recall),
			f1: fmt(r.f1),
			coverage: fmt(r.coverage),
			lift: fmt(r.lift),
			baseline: fmt(r.baseline),
		})),
		[
			"strategyId",
			"positives",
			"uniqueTokens",
			"goodPred",
			"neutralPred",
			"badPred",
			"precision",
			"recall",
			"f1",
			"coverage",
			"lift",
			"baseline",
			"totalMarked",
			"totalGoodMarked",
		]
	);
	fs.writeFileSync(path.join(outDir, "strategy_metrics.json"), JSON.stringify({ baseline, totalMarked, totalGoodMarked, strategies: rows }, null, 2));

	// Build HTML report
	const strategiesCfg = loadStrategiesCfg();
	const html = buildHtml({ baseline, totalMarked, totalGoodMarked, rows, strategiesCfg });
	fs.writeFileSync(path.join(outDir, "report.html"), html, "utf8");

	console.log("Estrategias analizadas:");
	console.log(`Baseline (good-rate) en marcadas: ${fmt(baseline, 4)}`);
	for (const r of rows) {
		console.log(
			`- ${r.strategyId}: positives=${r.positives}, good=${r.goodPred}, neutral=${r.neutralPred}, bad=${r.badPred}, precision=${fmt(r.precision, 4)}, recall=${fmt(r.recall, 4)}, f1=${fmt(r.f1, 4)}, coverage=${fmt(r.coverage, 4)}, lift=${fmt(r.lift, 2)}`
		);
	}
	console.log(`Salida: ${outDir}/strategy_metrics.(csv|json)`);
	console.log(`Reporte HTML: ${path.join(outDir, "report.html")}`);
}

main().catch((e) => {
	console.error("Error:", e);
	process.exit(1);
});

// ---------- HTML helpers ----------
function loadStrategiesCfg() {
	try {
		if (!fs.existsSync(strategiesFile)) return [];
		const txt = fs.readFileSync(strategiesFile, "utf8");
		const arr = JSON.parse(txt);
		return Array.isArray(arr) ? arr : [];
	} catch {
		return [];
	}
}

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

function makeEnvFromFilters(f) {
	if (!f) return "";
	const lines = [
		`TRACK_FILTERS_ENABLED=true`,
		`TRACK_ALL_MINTS=${f.trackAllMints ? "true" : "false"}`,
		`TRACK_MIN_BUYS=${envNumInt(f.minBuys)}`,
		`TRACK_MIN_TOTAL_TRADES=${envNumInt(f.minTotalTrades)}`,
		`TRACK_MIN_UNIQUE_TRADERS=${envNumInt(f.minUniqueTraders)}`,
		`TRACK_MIN_BUY_RATIO=${envNumDec(f.minBuyRatio, 2)}`,
		`TRACK_MIN_NET_BUYS=${envNumInt(f.minNetBuys)}`,
		`TRACK_MIN_MC_USD=${envNumInt(f.minMcUsd)}`,
		`TRACK_MAX_MC_USD=${f.maxMcUsd == null ? "" : envNumInt(f.maxMcUsd)}`,
		`TRACK_MIN_UNIQUE_PER_TRADE=${f.minUniquePerTrade == null ? 0 : envNumDec(f.minUniquePerTrade, 2)}`,
		`TRACK_MIN_BUYS_PER_UNIQUE=${f.minBuysPerUnique == null ? 0 : envNumDec(f.minBuysPerUnique, 2)}`,
		`TRACK_MAX_AGE_AT_TRIGGER_SEC=${f.maxAgeAtTriggerSec == null ? "" : envNumInt(f.maxAgeAtTriggerSec)}`,
		`TRACK_MAX_MC_VOLATILITY_RATIO=${f.maxMcVolatilityRatio == null ? "" : envNumDec(f.maxMcVolatilityRatio, 2)}`,
	];
	return lines.join("\n");
}

function buildHtml({ baseline, _totalMarked, _totalGoodMarked, rows, strategiesCfg }) {
	const css = `
  :root { --bg:#eceff4; --panel:#fff; --panel-alt:#fff; --border:#d8dee9; --text:#2e3440; --muted:#4c566a; --heading:#2e3440; --code-bg:#e5e9f0; --accent:#5e81ac; --badge-bg:#e5e9f0; }
  :root[data-theme='dark'] { --bg:#1e1e2e; --panel:#181825; --panel-alt:#11111b; --border:#313244; --text:#cdd6f4; --muted:#a6adc8; --heading:#cdd6f4; --code-bg:#313244; --accent:#89b4fa; --badge-bg:#313244; }
  *{box-sizing:border-box} body{font-family:'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace;margin:0;color:var(--text);background:var(--bg);} .container{width:100%;max-width:100%;padding:16px}
  header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:16px} h1{margin:0;font-size:24px;color:var(--heading)} .toolbar{display:flex;gap:12px;align-items:center}
  .badge{border:1px solid var(--border);padding:6px 10px;border-radius:999px;background:var(--panel);color:var(--text)}
  .card{border:1px solid var(--border);border-radius:12px;padding:12px 14px;background:var(--panel);margin-bottom:10px}
  .grid{display:grid;grid-template-columns:1fr;gap:12px} @media(min-width:1100px){.grid{grid-template-columns:1fr 1fr 1fr}}
  .cond-badges{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px} .cond{border:1px dashed var(--border);padding:6px 10px;border-radius:10px;background:var(--badge-bg)}
  .copy-btn{margin-top:6px;border:1px solid var(--border);background:var(--panel);color:var(--text);padding:6px 10px;border-radius:8px;cursor:pointer}
  .copy-btn:hover{background:var(--badge-bg)}
  table{border-collapse:separate;border-spacing:0;width:100%;border:1px solid var(--border);border-radius:12px;overflow:hidden}
  th,td{padding:8px 10px;text-align:right} thead th{background:var(--badge-bg)} td.label,th.label{text-align:left}
  `;

	function renderTable() {
		const header = `
      <tr>
        <th class="label">strategyId</th>
        <th>positives</th><th>uniqueTokens</th>
        <th>good</th><th>neutral</th><th>bad</th>
        <th>precision</th><th>recall</th><th>F1</th><th>coverage</th><th>lift</th>
      </tr>`;
		const body = rows
			.map(
				(r) => `
      <tr>
        <td class="label">${htmlesc(r.strategyId)}</td>
        <td>${fmtNum(r.positives, 0)}</td><td>${fmtNum(r.uniqueTokens, 0)}</td>
        <td>${fmtNum(r.goodPred, 0)}</td><td>${fmtNum(r.neutralPred, 0)}</td><td>${fmtNum(r.badPred, 0)}</td>
        <td>${fmtPct(r.precision)}</td><td>${fmtPct(r.recall)}</td><td>${fmtPct(r.f1)}</td><td>${fmtPct(r.coverage)}</td><td>${fmtNum(r.lift, 2)}</td>
      </tr>`
			)
			.join("");
		return `<div class="card"><h3>Métricas por estrategia</h3><div class="table-wrap"><table>${header}${body}</table></div></div>`;
	}

	function renderCards() {
		if (!Array.isArray(strategiesCfg) || strategiesCfg.length === 0) return '<div class="card muted">No se encontró strategies.json</div>';
		const items = strategiesCfg
			.map((s) => {
				const id = s.id || "strategy";
				const f = s.trackingFilters || {};
				const env = makeEnvFromFilters(f);
				const chips = [
					f.minBuyRatio != null ? `buyRatio ≥ ${fmtNum(f.minBuyRatio, 2)}` : null,
					f.minBuys != null ? `preBuys ≥ ${fmtNum(f.minBuys, 0)}` : null,
					f.minTotalTrades != null ? `preTotalTrades ≥ ${fmtNum(f.minTotalTrades, 0)}` : null,
					f.minUniqueTraders != null ? `preUniqueTraders ≥ ${fmtNum(f.minUniqueTraders, 0)}` : null,
					f.minNetBuys != null ? `netBuys ≥ ${fmtNum(f.minNetBuys, 0)}` : null,
					f.minMcUsd != null ? `minMcUsd ≥ ${fmtNum(f.minMcUsd, 0)}` : null,
					f.maxMcUsd != null ? `maxMcUsd ≤ ${fmtNum(f.maxMcUsd, 0)}` : null,
					f.minUniquePerTrade != null ? `uniquePerTrade ≥ ${fmtNum(f.minUniquePerTrade, 2)}` : null,
					f.minBuysPerUnique != null ? `buysPerUnique ≥ ${fmtNum(f.minBuysPerUnique, 2)}` : null,
					f.maxAgeAtTriggerSec != null ? `ageAtTriggerSec ≤ ${fmtNum(f.maxAgeAtTriggerSec, 0)}` : null,
					f.maxMcVolatilityRatio != null ? `mcVolRatio ≤ ${fmtNum(f.maxMcVolatilityRatio, 2)}` : null,
				]
					.filter(Boolean)
					.map((c) => `<span class="cond">${htmlesc(c)}</span>`)
					.join("");
				return `
        <div class="card">
          <h3>${htmlesc(id)}</h3>
          <div class="cond-badges">${chips || ""}</div>
          <div class="small" style="margin-top:10px;">
            <div>Snippet .env (copiar/pegar):</div>
            <code id="env-${htmlesc(id)}" style="display:block; white-space:pre; margin-top:6px;">${htmlesc(env)}</code>
            <button class="copy-btn" data-target="env-${htmlesc(id)}">Copiar</button>
          </div>
        </div>`;
			})
			.join("");
		return `<div class="grid">${items}</div>`;
	}

	return `<!doctype html><html lang="es"><head>
    <meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>Resumen por Estrategia</title>
    <style>${css}</style>
  </head><body><div class="container">
    <header><h1>Resumen por Estrategia</h1><div class="toolbar"><span class="badge">Baseline: ${fmtPct(baseline)}</span>
      <button class="copy-btn" id="themeToggle">Tema: <span id="themeLabel">Claro</span></button></div></header>
    ${renderTable()}
    <div class="card"><h3>Snippets .env por estrategia (Etapa 1)</h3>${renderCards()}</div>
  </div>
  <script>(function(){const r=document.documentElement,b=document.getElementById('themeToggle'),l=document.getElementById('themeLabel');function a(t){if(t==='dark'){r.setAttribute('data-theme','dark');l.textContent='Oscuro';}else{r.removeAttribute('data-theme');l.textContent='Claro';}localStorage.setItem('stTheme',t);}a(localStorage.getItem('stTheme')||'light');b.addEventListener('click',()=>{const c=r.getAttribute('data-theme')==='dark'?'dark':'light';a(c==='dark'?'light':'dark');});})();(function(){document.querySelectorAll('.copy-btn[data-target]').forEach(btn=>{btn.addEventListener('click',async()=>{const id=btn.getAttribute('data-target');const code=document.getElementById(id);if(!code)return;try{await navigator.clipboard.writeText(code.innerText);const o=btn.textContent;btn.textContent='Copiado!';setTimeout(()=>btn.textContent=o,1500);}catch(e){console.error('Copy failed',e);}});});})();</script>
  </body></html>`;
}
