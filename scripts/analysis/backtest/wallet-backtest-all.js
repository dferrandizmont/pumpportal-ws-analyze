import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import dotenv from "dotenv";

dotenv.config();

// Configuración de optimización
const OPTIMIZATION_ENABLED = process.env.BACKTEST_OPTIMIZE === "true";
const TP_VALUES = process.env.BACKTEST_TP_RANGE ? process.env.BACKTEST_TP_RANGE.split(",").map((x) => parseFloat(x.trim())) : [5, 8, 10, 12, 15, 20, 25];
const SL_VALUES = process.env.BACKTEST_SL_RANGE ? process.env.BACKTEST_SL_RANGE.split(",").map((x) => parseFloat(x.trim())) : [25, 30, 36, 45, 50];

// Optimizaciones de rendimiento
const BATCH_SIZE = parseInt(process.env.BACKTEST_BATCH_SIZE || "5"); // Combinaciones por lote
const MAX_PARALLEL = parseInt(process.env.BACKTEST_MAX_PARALLEL || "3"); // Lotes paralelos máximo
const SMART_SAMPLING = process.env.BACKTEST_SMART_SAMPLING !== "false"; // true por defecto

function readStrategies() {
	try {
		const strategiesFile = process.env.STRATEGIES_FILE || path.join(process.cwd(), "strategies.json");
		if (fs.existsSync(strategiesFile)) {
			const raw = fs.readFileSync(strategiesFile, "utf8");
			const arr = JSON.parse(raw);
			return Array.isArray(arr) ? arr : [];
		}
	} catch {
		// ignore
	}
	return [];
}

function ensureDirSync(dir) {
	fs.mkdirSync(dir, { recursive: true });
}

async function runBacktest(strategyId, tpPct, slPct, outDir) {
	return new Promise((resolve, reject) => {
		const env = {
			...process.env,
			BACKTEST_STRATEGY_ID: strategyId,
			BACKTEST_TP_PCT: tpPct.toString(),
			BACKTEST_SL_PCT: slPct.toString(),
			BACKTEST_OUTPUT_DIR: outDir,
		};
		const child = spawn(process.execPath, [path.join("scripts", "analysis", "backtest", "wallet-backtest.js")], {
			stdio: "pipe", // Cambiar a pipe para capturar output
			env,
		});

		let output = "";
		child.stdout.on("data", (data) => {
			output += data.toString();
		});

		child.stderr.on("data", (data) => {
			output += data.toString();
		});

		child.on("close", (code) => {
			if (code === 0) {
				resolve({ success: true, output });
			} else {
				resolve({ success: false, output });
			}
		});

		child.on("error", reject);
	});
}

// Función para crear lotes de combinaciones
function createBatches(tpValues, slValues, batchSize) {
	const combinations = [];
	for (const tpPct of tpValues) {
		for (const slPct of slValues) {
			combinations.push({ tpPct, slPct });
		}
	}

	const batches = [];
	for (let i = 0; i < combinations.length; i += batchSize) {
		batches.push(combinations.slice(i, i + batchSize));
	}
	return batches;
}

// Función para procesar un lote de combinaciones en paralelo
async function processBatch(strategyId, batch, outDir, batchIndex) {
	console.log(`   🔄 Batch ${batchIndex + 1}: Processing ${batch.length} combinations...`);

	const promises = batch.map(async ({ tpPct, slPct }) => {
		const comboId = `${strategyId}-tp${tpPct}-sl${slPct}`;
		const comboOutDir = path.join(outDir, comboId);

		try {
			const result = await runBacktest(strategyId, tpPct, slPct, comboOutDir);

			if (result.success) {
				const summaryPath = path.join(comboOutDir, "summary.json");
				if (fs.existsSync(summaryPath)) {
					const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));

					const score = (summary.profitFactor || 0) * 0.35 + (summary.totalReturn || 0) * 0.25 + (summary.winRate || 0) * 0.25 + (1 - (summary.maxDrawdown || 1)) * 0.15;

					// También mantener clasificación absoluta para contexto
					let absoluteClass = "NEUTRAL";
					if ((summary.totalReturn || 0) >= 20) absoluteClass = "GOOD_ABS";
					else if ((summary.totalReturn || 0) <= -36) absoluteClass = "BAD_ABS";

					return {
						tpPct,
						slPct,
						score,
						summary,
						comboId,
						comboOutDir,
						success: true,
						absoluteClass,
					};
				}
			}

			return {
				tpPct,
				slPct,
				success: false,
				error: result.output?.split("\n").slice(-3).join(" ") || "Unknown error",
			};
		} catch (error) {
			return {
				tpPct,
				slPct,
				success: false,
				error: error.message,
			};
		}
	});

	return Promise.all(promises);
}

// Función de smart sampling para reducir combinaciones
function smartSampleCombinations(tpValues, slValues, maxCombinations = 50) {
	const total = tpValues.length * slValues.length;

	if (total <= maxCombinations || !SMART_SAMPLING) {
		return { tpValues, slValues };
	}

	console.log(`   🎯 Smart sampling: ${total} → ${maxCombinations} combinaciones`);

	// Mantener valores clave de TP y SL
	const keyTpValues = [5, 10, 15, 20, 25];
	const keySlValues = [25, 30, 36, 45, 50];

	// Filtrar valores que existen en los arrays originales
	const filteredTp = tpValues.filter((tp) => keyTpValues.includes(tp));
	const filteredSl = slValues.filter((sl) => keySlValues.includes(sl));

	return {
		tpValues: filteredTp.length > 0 ? filteredTp : tpValues.slice(0, Math.ceil(Math.sqrt(maxCombinations))),
		slValues: filteredSl.length > 0 ? filteredSl : slValues.slice(0, Math.ceil(Math.sqrt(maxCombinations))),
	};
}

async function runOne(strategyId, outDir) {
	if (!OPTIMIZATION_ENABLED) {
		// Modo normal: usar parámetros del .env
		return new Promise((resolve, reject) => {
			const env = { ...process.env, BACKTEST_STRATEGY_ID: strategyId, BACKTEST_OUTPUT_DIR: outDir };
			const child = spawn(process.execPath, [path.join("scripts", "analysis", "backtest", "wallet-backtest.js")], {
				stdio: "inherit",
				env,
			});
			child.on("exit", (code) => {
				if (code === 0) resolve();
				else reject(new Error(`wallet-backtest failed for ${strategyId} (code ${code})`));
			});
			child.on("error", reject);
		});
	}

	// Aplicar smart sampling si es necesario
	const { tpValues: sampledTp, slValues: sampledSl } = smartSampleCombinations(TP_VALUES, SL_VALUES);
	const totalCombinations = sampledTp.length * sampledSl.length;

	console.log(`🎯 Optimizing ${strategyId} with ${totalCombinations} combinations...`);
	console.log(`   📊 TP: [${sampledTp.join(", ")}]%`);
	console.log(`   📊 SL: [${sampledSl.join(", ")}]%`);
	console.log(`   ⚡ Batch size: ${BATCH_SIZE} | Max parallel: ${MAX_PARALLEL}`);

	// Create batches
	const batches = createBatches(sampledTp, sampledSl, BATCH_SIZE);

	const results = [];
	let bestResult = null;
	let bestScore = -Infinity; // Initialize bestScore to avoid ESLint errors

	// Process batches with concurrency control
	for (let i = 0; i < batches.length; i += MAX_PARALLEL) {
		const currentBatches = batches.slice(i, i + MAX_PARALLEL);
		console.log(`\n   📦 Processing batches ${i + 1}-${Math.min(i + MAX_PARALLEL, batches.length)} of ${batches.length}...`);

		const batchPromises = currentBatches.map((batch, batchIndex) => processBatch(strategyId, batch, outDir, i + batchIndex));

		const batchResults = await Promise.all(batchPromises);

		// Procesar resultados de todos los lotes
		batchResults.flat().forEach((result) => {
			if (result.success) {
				results.push(result);

				if (result.score > bestScore) {
					bestScore = result.score;
					bestResult = result;
				}
			} else {
				console.log(`      ❌ TP ${result.tpPct}% + SL ${result.slPct}% falló: ${result.error}`);
			}
		});

		// Después de procesar todos los resultados, calcular clasificaciones relativas
		if (results.length > 0) {
			// Asegurar que bestScore tenga un valor válido
			const finalBestScore = typeof bestScore === "number" && bestScore !== -Infinity ? bestScore : Math.max(...results.map((r) => r.score));

			results.forEach((result) => {
				// Calcular clasificación relativa al mejor resultado
				const relativeScore = finalBestScore !== 0 ? (result.score / finalBestScore) * 100 : 0;

				let classification = "NEUTRAL";
				if (relativeScore >= 80) classification = "EXCELENTE";
				else if (relativeScore >= 60) classification = "BUENO";
				else if (relativeScore >= 40) classification = "REGULAR";
				else if (relativeScore < 40) classification = "MALO";

				// Agregar propiedades calculadas
				result.relativeScore = relativeScore;
				result.classification = classification;

				console.log(
					`      ✅ TP ${result.tpPct}% + SL ${result.slPct}% | Score: ${result.score.toFixed(3)} | Return: ${result.summary.totalReturn?.toFixed(2)}% | ${classification} (${relativeScore.toFixed(1)}%)`
				);
			});
		} else {
			console.log(`      ⚠️ No valid results to calculate classifications`);
		}
	}

	if (!bestResult) {
		throw new Error(`Could not find a valid combination for ${strategyId}`);
	}

	// Copy the best result to the main strategy directory
	console.log(`\n🏆 Best combination for ${strategyId}: TP ${bestResult.tpPct}% + SL ${bestResult.slPct}%`);
	console.log(`   Score: ${bestResult.score.toFixed(3)} (${bestResult.classification})`);
	console.log(`   Return: ${bestResult.summary.totalReturn?.toFixed(2)}%`);
	console.log(`   Profit Factor: ${bestResult.summary.profitFactor?.toFixed(2)}`);
	console.log(`   Classification: ${bestResult.classification} (relative) | ${bestResult.absoluteClass} (absolute)`);

	// Copy files from the best result
	const bestFiles = fs.readdirSync(bestResult.comboOutDir);
	for (const file of bestFiles) {
		const srcPath = path.join(bestResult.comboOutDir, file);
		const destPath = path.join(outDir, file);
		if (fs.statSync(srcPath).isFile()) {
			fs.copyFileSync(srcPath, destPath);
		}
	}

	// Add optimization information to summary.json
	const finalSummaryPath = path.join(outDir, "summary.json");
	if (fs.existsSync(finalSummaryPath)) {
		const summary = JSON.parse(fs.readFileSync(finalSummaryPath, "utf8"));
		summary.optimization = {
			enabled: true,
			tpPct: bestResult.tpPct,
			slPct: bestResult.slPct,
			score: bestResult.score,
			classification: bestResult.classification,
			absoluteClass: bestResult.absoluteClass,
			relativeScore: bestResult.relativeScore,
			combinationsTested: results.length,
			allResults: results.map((r) => ({
				tpPct: r.tpPct,
				slPct: r.slPct,
				score: r.score,
				totalReturn: r.summary.totalReturn,
				profitFactor: r.summary.profitFactor,
				winRate: r.summary.winRate,
				maxDrawdown: r.summary.maxDrawdown,
				classification: r.classification || "NEUTRAL",
				absoluteClass: r.absoluteClass || "NEUTRAL",
				relativeScore: r.relativeScore || 0,
			})),
		};
		fs.writeFileSync(finalSummaryPath, JSON.stringify(summary, null, 2));
	}

	console.log(`   ✅ Optimization completed for ${strategyId}`);
}

function buildIndexHtml(entries) {
	const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
	const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + "%" : "-");
	const pct100 = (x) => (Number.isFinite(x) ? x.toFixed(2) + "%" : "-");
	const num = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "-");

	// Contar estrategias optimizadas
	const optimizedCount = entries.filter((e) => e.summary?.optimization?.enabled).length;
	const totalStrategies = entries.length;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Wallet Backtests</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap');
    
    :root {
      /* Ayu Mirage Theme Palette */
      --bg-primary: #1f2430;        /* Ayu Mirage Primary Background */
      --bg-secondary: #1c212b;      /* Ayu Mirage Secondary Background */
      --bg-tertiary: #242936;       /* Ayu Mirage Tertiary Background */
      --bg-surface: #171b24;        /* Ayu Mirage Surface */
      --text-primary: #cccac2;      /* Ayu Mirage Primary Text */
      --text-secondary: #707a8c;    /* Ayu Mirage Secondary Text */
      --text-muted: #eceff4;        /* Ayu Mirage Muted Text - More visible */
      --accent-primary: #ffcc66;    /* Ayu Mirage Yellow (Principal) */
      --accent-secondary: #ebcb8b;  /* Ayu Mirage Blue */
      --success: #a3be8c;           /* Ayu Mirage Green */
      --danger: #bf616a;            /* Ayu Mirage Red */
      --warning: #d08770;           /* Ayu Mirage Orange */
      --info: #5ccfe6;              /* Ayu Mirage Cyan */
      --border: #63759926;          /* Ayu Mirage Border */
      --border-solid: #434c5e;      /* Ayu Mirage Solid Border */
      --shadow: 0 4px 6px -1px rgba(18, 21, 28, 0.6), 0 2px 4px -1px rgba(18, 21, 28, 0.4);
    }
    
    * { box-sizing: border-box; }
    
    body {
      margin: 0;
      background: var(--bg-primary);
      color: var(--text-primary);
      font: 14px/1.45 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace;
    }
    
    .wrap {
      max-width: 1600px;
      margin: 24px auto;
      padding: 0 16px 48px;
    }
    
    h1 {
      font-size: 28px;
      margin: 0 0 8px;
      color: var(--text-primary);
      font-weight: 700;
    }
    
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
      gap: 20px;
      margin-top: 20px;
    }
    
    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-solid);
      border-radius: 12px;
      padding: 20px;
      transition: all 0.3s ease;
      box-shadow: var(--shadow);
      min-height: 200px;
      display: flex;
      flex-direction: column;
    }
    
    .card:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px -5px rgba(18, 21, 28, 0.8);
    }
    
    .top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      margin-bottom: 12px;
      gap: 16px;
      flex-grow: 1;
    }
    
    .id {
      font-weight: 700;
      font-size: 16px;
      color: var(--text-primary);
    }
    
    .name {
      color: var(--text-muted);
      font-size: 12px;
      margin-top: 2px;
    }
    .desc { color: var(--text-secondary); font-size: 12px; margin-top: 6px; line-height: 1.4; }
    
    a {
      color: var(--accent-secondary);
      text-decoration: none;
      font-weight: 600;
      font-size: 13px;
      padding: 8px 16px;
      background: rgba(115, 208, 255, 0.1);
      border-radius: 8px;
      border: 1px solid rgba(115, 208, 255, 0.3);
      transition: all 0.2s ease;
      white-space: nowrap;
      align-self: flex-start;
      flex-shrink: 0;
    }
    
    a:hover {
      background: rgba(115, 208, 255, 0.2);
      color: var(--accent-primary);
      text-decoration: none;
    }
    
    .muted {
      color: var(--text-muted);
      margin-bottom: 4px;
    }
    
    .kpis {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
      margin-top: auto;
      padding-top: 12px;
    }
    
    .kpi {
      background: var(--bg-surface);
      border: 1px solid var(--border-solid);
      border-radius: 8px;
      padding: 10px;
      transition: background 0.2s ease;
    }
    
    .kpi:hover {
      background: var(--bg-secondary);
    }
    
    .kpi b {
      display: block;
      color: var(--text-muted);
      font-size: 11px;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 600;
    }
    
    .val {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }
    
    .pos { color: var(--success); }
    .neg { color: var(--danger); }
    
    @media (max-width: 768px) {
      .grid {
        grid-template-columns: 1fr;
      }
      .card {
        min-height: auto;
      }
      .top {
        flex-direction: column;
        align-items: stretch;
        gap: 12px;
      }
      a {
        align-self: center;
        padding: 10px 20px;
      }
    }
  </style></head>
  <body><div class="wrap">
    <h1>Wallet Backtests by Strategy</h1>
    <div class="muted">
      ${
			OPTIMIZATION_ENABLED
				? `${optimizedCount}/${totalStrategies} strategies optimized with TP/SL parameter tuning.`
				: "A report was generated for each strategy using .env parameters."
		}
      Click to open detailed reports.
    </div>
    <div class="grid">
      ${entries
			.map((e) => {
				const s = e.summary || {};
				const wr = pct(s.winRate);
				const tr = Number.isFinite(s.trades) ? String(s.trades) : "-";
				const fin = Number.isFinite(s.finalSol) ? num(s.finalSol, 3) + " SOL" : "-";
				const ret = Number.isFinite(s.totalReturn) ? pct100(s.totalReturn) : "-";
				const dd = pct(s.maxDrawdown);
				const retClass = Number.isFinite(s.totalReturn) && s.totalReturn >= 0 ? "pos" : "neg";

				// Información de optimización
				const optimization = s.optimization;
				let optimizationInfo = "";
				if (optimization?.enabled) {
					optimizationInfo = `<div style="margin-top: 8px; padding: 6px 12px; background: rgba(163, 190, 140, 0.2); border: 1px solid #a3be8c; border-radius: 6px; font-size: 11px; color: #a3be8c;">
						<strong>🎯 OPTIMIZED:</strong> TP ${optimization.tpPct}% + SL ${optimization.slPct}% (${optimization.combinationsTested} combos)
					</div>`;
				}

				return (
					`<div class="card">\n` +
					`<div class="top">\n` +
					`<div>\n<div class="id">${esc(e.id)}</div>\n<div class="name">${esc(e.name || "")}</div>\n<div class="desc">${esc(e.description || "")}</div>\n${optimizationInfo}\n</div>\n` +
					`<div><a href="${encodeURIComponent(e.id)}/report.html">Open Report</a></div>\n` +
					`</div>\n` +
					`<div class="kpis">\n` +
					`<div class="kpi"><b>Final</b><div class="val">${fin}</div></div>\n` +
					`<div class="kpi"><b>Trades</b><div class="val">${tr}</div></div>\n` +
					`<div class="kpi"><b>WinRate</b><div class="val">${wr}</div></div>\n` +
					`<div class="kpi"><b>Return</b><div class="val ${retClass}">${ret}</div></div>\n` +
					`<div class="kpi"><b>MaxDD</b><div class="val">${dd}</div></div>\n` +
					`</div>\n` +
					`</div>`
				);
			})
			.join("")}
    </div>
  </div></body></html>`;
}

async function main() {
	const strategies = readStrategies();
	if (!strategies.length) {
		console.error("No strategies found in strategies.json");
		process.exit(1);
	}
	const baseOut = path.join("backtest-output", "wallet");
	ensureDirSync(baseOut);
	const conc = parseInt(process.env.BACKTEST_ALL_CONCURRENCY || process.argv[2] || "0", 10) || Math.max(1, (os.cpus()?.length || 2) - 1);

	if (OPTIMIZATION_ENABLED) {
		console.log(`🚀 Running OPTIMIZED wallet-backtest for ${strategies.length} strategies`);
		console.log(`   📊 TP Range: [${TP_VALUES.join(", ")}]% (${TP_VALUES.length} values)`);
		console.log(`   📊 SL Range: [${SL_VALUES.join(", ")}]% (${SL_VALUES.length} values)`);
		console.log(`   📊 Total combinations per strategy: ${TP_VALUES.length * SL_VALUES.length}`);

		if (SMART_SAMPLING) {
			const maxComb = 50;
			const willSample = TP_VALUES.length * SL_VALUES.length > maxComb;
			console.log(`   🎯 Smart sampling: ${willSample ? "ENABLED" : "NOT NEEDED"} (max. ${maxComb} combinations)`);
		}

		console.log(`   📦 Batch size: ${BATCH_SIZE} combinations per batch`);
		console.log(`   ⚡ Max parallel: ${MAX_PARALLEL} simultaneous batches`);
		console.log(`   🎯 Will select BEST TP/SL combination for each strategy`);
	} else {
		console.log(`Running wallet-backtest for ${strategies.length} strategies with concurrency=${conc}...`);
		console.log(`   📊 Using .env parameters: TP=${process.env.BACKTEST_TP_PCT || "10"}%, SL=${process.env.BACKTEST_SL_PCT || "36"}%`);
	}
	console.log("");

	let idx = 0;
	async function worker(wid) {
		while (idx < strategies.length) {
			const myIdx = idx++;
			const s = strategies[myIdx];
			const sid = s?.id;
			if (!sid) continue;
			const outDir = path.join(baseOut, sid);
			// Limpieza opcional del directorio de salida por estrategia
			if (process.env.BACKTEST_ALL_CLEAN === "1" && fs.existsSync(outDir)) {
				try {
					for (const f of fs.readdirSync(outDir)) {
						fs.rmSync(path.join(outDir, f), { recursive: true, force: true });
					}
				} catch {
					// ignore
				}
			}
			ensureDirSync(outDir);
			console.log(`[w${wid}] [${myIdx + 1}/${strategies.length}] Strategy: ${sid} -> ${outDir}`);
			try {
				await runOne(sid, outDir);
			} catch (e) {
				console.error(`[w${wid}] Failed strategy ${sid}:`, e?.message || e);
				// continuar
			}
		}
	}

	const workers = Array.from({ length: Math.min(conc, strategies.length) }, (_, i) => worker(i + 1));
	await Promise.all(workers);

	// Generate index with KPIs per strategy
	const entries = strategies
		.filter((s) => s?.id)
		.map((s) => {
			const p = path.join(baseOut, s.id, "summary.json");
			let summary = null;
			try {
				if (fs.existsSync(p)) summary = JSON.parse(fs.readFileSync(p, "utf8"));
			} catch {
				// ignore
			}
			return { id: s.id, name: s.name || "", description: s.description || "", summary };
		});
	const indexHtml = buildIndexHtml(entries);
	fs.writeFileSync(path.join(baseOut, "index.html"), indexHtml, "utf8");

	if (OPTIMIZATION_ENABLED) {
		const optimizedStrategies = entries.filter((e) => e.summary?.optimization?.enabled).length;
		console.log(`✅ Optimization completed!`);
		console.log(`   📊 ${optimizedStrategies}/${strategies.length} strategies successfully optimized`);
		console.log(`   🎯 Each strategy tested ${TP_VALUES.length * SL_VALUES.length} TP/SL combinations`);
		console.log(`   🏆 Best parameters selected for each strategy`);
		console.log(`   🌐 Index updated with optimization results`);
	} else {
		console.log(`Index created at ${path.join(baseOut, "index.html")}`);
	}
}

main().catch((e) => {
	console.error("Error in wallet-backtest-all:", e);
	process.exit(1);
});
