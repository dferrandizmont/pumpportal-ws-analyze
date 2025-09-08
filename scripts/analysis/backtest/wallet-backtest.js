import fs from "fs";
import path from "path";
import os from "os";
import dotenv from "dotenv";
import { ensureDirSync, writeCsv } from "../../analysis/lib/jsonl.js";
import { parseTrackingSessions } from "./lib/tracking-parse.js";

dotenv.config();

// OUTPUT_DIR will be set later after we know the strategyId

function readStrategies() {
	try {
		const strategiesFile = process.env.STRATEGIES_FILE || path.join(process.cwd(), "strategies.json");
		if (fs.existsSync(strategiesFile)) {
			const raw = fs.readFileSync(strategiesFile, "utf8");
			const arr = JSON.parse(raw);
			return Array.isArray(arr) ? arr : [];
		}
	} catch (_e) {
		void 0; // ignore
	}
	return [];
}

function getStrategyLogDir(strategyId) {
	const strategies = readStrategies();
	const s = strategies.find((x) => x.id === strategyId);
	if (s && s.tracking && typeof s.tracking.logDir === "string" && s.tracking.logDir.trim() !== "") {
		return s.tracking.logDir;
	}
	// Fallback: tracking/<strategyId>
	return path.join("tracking", strategyId);
}

function listTokenLogs(dir) {
	try {
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith("-websocket.log"))
			.map((f) => path.join(dir, f));
	} catch (_e) {
		return [];
	}
}

function tokenFromFilename(filePath) {
	const base = path.basename(filePath);
	return base.endsWith("-websocket.log") ? base.slice(0, -"-websocket.log".length) : base;
}

async function parseAllSessions(files, { concurrency = Math.max(4, os.cpus().length - 1), limit = 0 } = {}) {
	const results = [];
	let idx = 0;
	async function worker() {
		while (idx < files.length && (limit <= 0 || results.length < limit)) {
			const myIdx = idx++;
			const file = files[myIdx];
			try {
				const ses = await parseTrackingSessions(file);
				const token = tokenFromFilename(file);
				for (const s of ses) {
					results.push({ ...s, token });
					if (limit > 0 && results.length >= limit) break;
				}
			} catch (_e) {
				void 0; // ignore parse errors for this file
			}
		}
	}
	const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker());
	await Promise.all(workers);
	return results;
}

function asNumber(v, def) {
	const n = parseFloat(v);
	return Number.isFinite(n) ? n : def;
}

function computeDrawdown(equitySeries) {
	let peak = -Infinity;
	let maxDd = 0;
	for (const v of equitySeries) {
		if (v > peak) peak = v;
		const dd = peak > 0 ? (peak - v) / peak : 0;
		if (dd > maxDd) maxDd = dd;
	}
	return maxDd;
}

function toFixed(x, d = 4) {
	return Number.isFinite(x) ? Number(x.toFixed(d)) : 0;
}

async function main() {
	const strategyId = process.env.BACKTEST_STRATEGY_ID;
	if (!strategyId) {
		console.error("BACKTEST_STRATEGY_ID no está definido. Ejemplo: BACKTEST_STRATEGY_ID=f1Balanced");
		process.exit(1);
	}

	// Configure output directory for this specific strategy
	const OUTPUT_DIR = process.env.BACKTEST_OUTPUT_DIR || path.join("backtest-output", "wallet", strategyId);
	ensureDirSync(OUTPUT_DIR);

	const initialSol = asNumber(process.env.BACKTEST_INITIAL_SOL, 1.5);
	const allocSol = asNumber(process.env.BACKTEST_ALLOC_SOL, 0);
	const allocPct = allocSol > 0 ? 0 : asNumber(process.env.BACKTEST_ALLOC_PCT, 1.0); // por defecto 100% si no hay alloc SOL
	const tpPct = asNumber(process.env.BACKTEST_TP_PCT, 10);
	const slPct = Math.abs(asNumber(process.env.BACKTEST_SL_PCT, 5));
	const timeoutSec = asNumber(process.env.BACKTEST_TIMEOUT_SEC, 300);
	const feePct = asNumber(process.env.BACKTEST_FEE_PCT, 0);
	const slippagePct = asNumber(process.env.BACKTEST_SLIPPAGE_PCT, 0);
	// Costes adicionales realistas
	const apiType = (process.env.BACKTEST_API_TYPE || "lightning").toLowerCase(); // lightning | local
	const portalFeeDefault = apiType === "local" ? 0.5 : 1.0; // PumpPortal: Local=0.5% por trade, Lightning=1% por trade
	const portalFeePct = asNumber(process.env.BACKTEST_PORTAL_FEE_PCT, portalFeeDefault); // % por lado (entrada/salida)
	// Priority fee y otros transfer SOL (se restan como costes fijos)
	const priorityFeeEntrySol = asNumber(process.env.BACKTEST_PRIORITY_FEE_SOL_ENTRY, 0);
	const priorityFeeExitSol = asNumber(process.env.BACKTEST_PRIORITY_FEE_SOL_EXIT, 0);
	const extraTransfersEntrySol = asNumber(process.env.BACKTEST_EXTRA_TRANSFERS_SOL_ENTRY, 0);
	const extraTransfersExitSol = asNumber(process.env.BACKTEST_EXTRA_TRANSFERS_SOL_EXIT, 0);

	// Atajo opcional: agregados simples para no usar las 4 de arriba
	const extraSolEntryAgg = process.env.BACKTEST_EXTRA_SOL_ENTRY;
	const extraSolExitAgg = process.env.BACKTEST_EXTRA_SOL_EXIT;
	const aggEntry = extraSolEntryAgg != null && extraSolEntryAgg !== "" ? asNumber(extraSolEntryAgg, 0) : null;
	const aggExit = extraSolExitAgg != null && extraSolExitAgg !== "" ? asNumber(extraSolExitAgg, 0) : null;
	const entryFixedFeesSol = asNumber(process.env.BACKTEST_ENTRY_FIXED_FEES_SOL, 0.0025 + 0.0021 + 0.000905); // SOL por entrada
	const exitFixedFeesSol = asNumber(process.env.BACKTEST_EXIT_FIXED_FEES_SOL, 0.0025 + 0.0021 + 0.000905); // SOL por salida
	const limit = parseInt(process.env.BACKTEST_LIMIT || "0", 10) || 0;
	const conc = parseInt(process.env.BACKTEST_PARSE_CONCURRENCY || "6", 10) || 6;

	// Log de inicio con parámetros básicos
	console.log("Iniciando wallet backtest");
	console.log(
		[
			`Estrategia: ${strategyId}`,
			`Inicial SOL: ${initialSol}`,
			`Asignación SOL: ${allocSol}`,
			`Asignación %: ${allocPct}`,
			`TP %: ${tpPct}`,
			`SL %: ${slPct}`,
			`Timeout (s): ${timeoutSec}`,
			`Fee %: ${feePct}`,
			`Slippage %: ${slippagePct}`,
			`Portal API: ${apiType}`,
			`Portal fee % (lado): ${portalFeePct}`,
			`Fixed fees SOL in/out: ${entryFixedFeesSol}/${exitFixedFeesSol}`,
			`Límite sesiones: ${limit}`,
			`Parse concurrency: ${conc}`,
		].join(" | ")
	);

	// Fetch strategy description (if any)
	let strategyDescription = "";
	let strategyName = "";
	try {
		const meta = readStrategies().find((x) => x.id === strategyId);
		strategyDescription = meta?.description || "";
		strategyName = meta?.name || "";
	} catch {
		// ignore
	}

	const logDir = getStrategyLogDir(strategyId);
	console.log(`Directorio de tracking: ${logDir}`);
	const files = listTokenLogs(logDir);
	console.log(`Archivos de log encontrados: ${files.length}`);
	if (!files.length) {
		console.error(`No hay logs en ${logDir}. Asegúrate de tener tracking para la estrategia '${strategyId}'.`);
		process.exit(1);
	}

	const sessions = await parseAllSessions(files, { concurrency: conc, limit });
	if (!sessions.length) {
		console.error("No hay sesiones parseadas (todas podrían carecer de summary y se descartaron).");
		process.exit(1);
	}
	console.log(`[Wallet] Sesiones parseadas: ${sessions.length} (desde ${files.length} archivos)`);

	// Métricas de puntos para verificar volumen procesado
	const totalPoints = sessions.reduce((acc, s) => acc + (Array.isArray(s.points) ? s.points.length : 0), 0);
	const avgPoints = sessions.length ? totalPoints / sessions.length : 0;
	const maxPoints = sessions.reduce((m, s) => Math.max(m, Array.isArray(s.points) ? s.points.length : 0), 0);
	console.log(`[Wallet] Puntos totales=${totalPoints}, media por sesión=${avgPoints.toFixed(1)}, máx por sesión=${maxPoints}`);

	// Ordenar por startedAt ascendente; si falta, enviar al final
	sessions.sort((a, b) => {
		const ta = a.startedAt ? new Date(a.startedAt).getTime() : Number.POSITIVE_INFINITY;
		const tb = b.startedAt ? new Date(b.startedAt).getTime() : Number.POSITIVE_INFINITY;
		return ta - tb;
	});

	// Barra de progreso
	const startTs = Date.now();
	const totalSessions = sessions.length;
	let processed = 0;
	let lastDraw = 0;
	function drawProgress(force = false) {
		const now = Date.now();
		if (!force && now - lastDraw < 200) return; // limitar refresco
		lastDraw = now;
		const ratio = totalSessions ? Math.min(1, processed / totalSessions) : 0;
		const width = 40;
		const filled = Math.round(ratio * width);
		const bar = "#".repeat(filled) + "-".repeat(Math.max(0, width - filled));
		const pct = (ratio * 100).toFixed(1).padStart(5);
		const elapsed = (now - startTs) / 1000;
		const rate = processed && elapsed > 0 ? processed / elapsed : 0; // sesiones/s
		const remaining = Math.max(0, totalSessions - processed);
		const etaSec = rate > 0 ? remaining / rate : 0;
		const fmt = (s) => {
			if (!Number.isFinite(s)) return "?";
			if (s >= 3600) return `${Math.round(s / 3600)}h`;
			if (s >= 60) return `${Math.round(s / 60)}m`;
			return `${Math.round(s)}s`;
		};
		const line = `[${bar}] ${pct}%  ${processed.toLocaleString("es-ES")}/${totalSessions.toLocaleString("es-ES")}  ~${rate.toFixed(1)} ses/s  ETA ${fmt(etaSec)}`;
		process.stdout.write("\r" + line);
	}

	let wallet = initialSol;
	const trades = [];
	const equity = [wallet];
	let wins = 0,
		losses = 0;

	for (const s of sessions) {
		processed++;
		drawProgress();
		// Descarta sesiones sin puntos
		const pts = Array.isArray(s.points) ? s.points.slice().sort((x, y) => x.t - y.t) : [];
		if (!pts.length) continue;

		// Asignación
		const alloc = allocSol > 0 ? Math.min(allocSol, wallet) : Math.max(0, wallet * allocPct);
		if (alloc <= 0) break; // bancarrota efectiva

		let exitReason = "END";
		let exitPct = 0;
		let tExit = 0;
		let usedDelaySec = 0;

		// Detectar primer cruce TP/SL antes del timeout
		let crossed = null; // { reason: 'TP'|'SL', tCross: number }
		for (const p of pts) {
			if (p.pct >= tpPct) {
				crossed = { reason: "TP", tCross: p.t };
				break;
			}
			if (p.pct <= -slPct) {
				crossed = { reason: "SL", tCross: p.t };
				break;
			}
			if (p.t >= timeoutSec) break;
		}

		if (crossed) {
			// Simular congestión: delay aleatorio 1-3s y tomar % de ese momento
			const delaySec = 1 + Math.floor(Math.random() * 3); // 1..3
			usedDelaySec = delaySec;
			const targetT = crossed.tCross + delaySec;
			const delayed = pts.find((q) => q.t >= targetT) || pts[pts.length - 1];
			exitReason = crossed.reason;
			exitPct = delayed.pct;
			tExit = delayed.t;
		} else {
			// Si hay timeout en la sesión, salir sí o sí en el último punto; si no, END
			const hasTimeout = pts.some((p) => p.t >= timeoutSec);
			const last = pts[pts.length - 1];
			if (hasTimeout) {
				exitReason = "TIMEOUT";
				exitPct = last.pct;
				tExit = last.t;
			} else {
				exitReason = "END";
				exitPct = last.pct;
				tExit = last.t;
			}
		}

		// Costes: porcentuales ida+vuelta + comisiones fijas SOL (entrada+salida)
		const roundTripPctCosts = (feePct + slippagePct + portalFeePct) * 2;
		const netPct = exitPct - roundTripPctCosts;
		const fixedFeesSolRoundTrip = entryFixedFeesSol + exitFixedFeesSol;
		const priorityFeesSolRoundTrip = (aggEntry ?? priorityFeeEntrySol) - (aggEntry != null ? 0 : 0) + (aggExit ?? priorityFeeExitSol) - (aggExit != null ? 0 : 0);
		const extraTransfersSolRoundTrip = (aggEntry != null ? 0 : extraTransfersEntrySol) + (aggExit != null ? 0 : extraTransfersExitSol);
		// Si se usa agregado, se reparte en priority para informes y se ignoran extraTransfers correspondientes
		const effPriorityFeeEntrySol = aggEntry != null ? aggEntry : priorityFeeEntrySol;
		const effPriorityFeeExitSol = aggExit != null ? aggExit : priorityFeeExitSol;
		const totalFixedSol = fixedFeesSolRoundTrip + priorityFeesSolRoundTrip + extraTransfersSolRoundTrip;
		const pnl = alloc * (netPct / 100) - totalFixedSol;
		const walletBefore = wallet;
		wallet = wallet + pnl;
		equity.push(wallet);

		// Determine if the trade was actually profitable after all costs
		const isProfit = pnl > 0;

		if (isProfit) wins++;
		else losses++;

		// Adjust exit reason based on actual profitability
		let finalExitReason = exitReason;
		if (exitReason === "TP" && !isProfit) {
			finalExitReason = "TP_LOSS"; // TP signal but actually lost money
		} else if (exitReason === "SL" && isProfit) {
			finalExitReason = "SL_WIN"; // SL signal but actually made money
		} else if (exitReason === "TIMEOUT") {
			finalExitReason = isProfit ? "TIMEOUT_WIN" : "TIMEOUT_LOSS";
		} else if (exitReason === "END") {
			finalExitReason = isProfit ? "END_WIN" : "END_LOSS";
		}

		trades.push({
			strategyId,
			token: s.token || "",
			startedAt: s.startedAt || "",
			endedAt: s.endedAt || "",
			exitReason: finalExitReason,
			originalExitReason: exitReason, // Keep the original for reference
			exitPct,
			tExit,
			alloc,
			feePct,
			slippagePct,
			portalFeePct,
			netPct,
			pnl,
			walletBefore,
			walletAfter: wallet,
			entryFixedFeesSol,
			exitFixedFeesSol,
			fixedFeesSolRoundTrip,
			priorityFeeEntrySol: effPriorityFeeEntrySol,
			priorityFeeExitSol: effPriorityFeeExitSol,
			priorityFeesSolRoundTrip,
			extraTransfersEntrySol,
			extraTransfersExitSol,
			extraTransfersSolRoundTrip,
			delaySec: usedDelaySec,
		});

		if (wallet <= 0) {
			break; // bancarrota
		}
	}

	// Finalizar y avanzar línea de la barra
	drawProgress(true);
	process.stdout.write("\n");

	// Calcular métricas adicionales
	const maxDrawdown = computeDrawdown(equity);
	const totalReturn = initialSol > 0 ? ((wallet - initialSol) / initialSol) * 100 : 0;

	const winningTrades = trades.filter((t) => t.pnl > 0);
	const losingTrades = trades.filter((t) => t.pnl < 0);

	const avgWinningTrade = winningTrades.length > 0 ? winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length : 0;
	const avgLosingTrade = losingTrades.length > 0 ? losingTrades.reduce((sum, t) => sum + t.pnl, 0) / losingTrades.length : 0;

	const largestWin = winningTrades.length > 0 ? Math.max(...winningTrades.map((t) => t.pnl)) : 0;
	const largestLoss = losingTrades.length > 0 ? Math.min(...losingTrades.map((t) => t.pnl)) : 0;

	const totalProfits = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
	const totalLosses = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));
	const profitFactor = totalLosses > 0 ? totalProfits / totalLosses : totalProfits > 0 ? 999 : 0;

	// Distribución de razones de salida
	const exitReasons = trades.reduce((acc, t) => {
		acc[t.exitReason] = (acc[t.exitReason] || 0) + 1;
		return acc;
	}, {});

	const summary = {
		strategyId,
		initialSol,
		finalSol: toFixed(wallet, 6),
		totalReturn: toFixed(totalReturn, 2),
		trades: trades.length,
		wins,
		losses,
		winRate: trades.length ? toFixed(wins / trades.length, 4) : 0,
		maxDrawdown: toFixed(maxDrawdown, 4),
		avgWinningTrade: toFixed(avgWinningTrade, 6),
		avgLosingTrade: toFixed(avgLosingTrade, 6),
		largestWin: toFixed(largestWin, 6),
		largestLoss: toFixed(largestLoss, 6),
		profitFactor: toFixed(profitFactor, 2),
		totalProfits: toFixed(totalProfits, 6),
		totalLosses: toFixed(totalLosses, 6),
		exitReasons,
		params: {
			allocSol,
			allocPct,
			tpPct,
			slPct,
			timeoutSec,
			feePct,
			slippagePct,
			portalFeePct,
			apiType,
			entryFixedFeesSol,
			exitFixedFeesSol,
			limit,
		},
	};

	// Persist
	writeCsv(
		path.join(OUTPUT_DIR, "trades.csv"),
		trades.map((t) => ({
			...t,
			alloc: toFixed(t.alloc, 6),
			exitPct: toFixed(t.exitPct, 4),
			netPct: toFixed(t.netPct, 4),
			pnl: toFixed(t.pnl, 6),
			walletBefore: toFixed(t.walletBefore, 6),
			walletAfter: toFixed(t.walletAfter, 6),
		})),
		[
			"strategyId",
			"token",
			"startedAt",
			"endedAt",
			"exitReason",
			"tExit",
			"delaySec",
			"exitPct",
			"netPct",
			"alloc",
			"feePct",
			"slippagePct",
			"portalFeePct",
			"entryFixedFeesSol",
			"exitFixedFeesSol",
			"fixedFeesSolRoundTrip",
			"priorityFeeEntrySol",
			"priorityFeeExitSol",
			"priorityFeesSolRoundTrip",
			"extraTransfersEntrySol",
			"extraTransfersExitSol",
			"extraTransfersSolRoundTrip",
			"pnl",
			"walletBefore",
			"walletAfter",
		]
	);

	fs.writeFileSync(path.join(OUTPUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));

	// HTML with modern design and Catppuccin Macchiato color scheme
	const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Wallet Backtest · ${esc(strategyId)}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap');
    
    :root {
      /* Ayu Mirage Theme Palette */
      --bg-primary: #1f2430;        /* Ayu Mirage Primary Background */
      --bg-secondary: #1c212b;      /* Ayu Mirage Secondary Background */
      --bg-tertiary: #242936;       /* Ayu Mirage Tertiary Background */
      --bg-surface: #171b24;        /* Ayu Mirage Surface */
      --bg-card: #1c212b;
      --bg-card-hover: #242936;
      --text-primary: #cccac2;      /* Ayu Mirage Primary Text */
      --text-secondary: #707a8c;    /* Ayu Mirage Secondary Text */
      --text-muted: #eceff4;        /* Ayu Mirage Muted Text - More visible */
      --accent-primary: #ebcb8b;    /* Ayu Mirage Yellow (Principal) */
      --accent-secondary: #73d0ff;  /* Ayu Mirage Blue */
      --success: #a3be8c;           /* Ayu Mirage Green */
      --success-soft: #a3be8c;
      --danger: #bf616a;            /* Ayu Mirage Red */
      --danger-soft: #bf616a;
      --warning: #d08770;           /* Ayu Mirage Orange */
      --warning-soft: #d0877080;
      --info: #5ccfe6;              /* Ayu Mirage Cyan */
      --cyan: #95e6cb;              /* Ayu Mirage Cyan Light */
      --purple: #dfbfff;            /* Ayu Mirage Purple */
      --border: #63759926;          /* Ayu Mirage Border */
      --border-soft: #707a8c45;     /* Ayu Mirage Soft Border */
      --shadow: 0 4px 6px -1px rgba(18, 21, 28, 0.6), 0 2px 4px -1px rgba(18, 21, 28, 0.4);
      --shadow-lg: 0 10px 15px -3px rgba(18, 21, 28, 0.7), 0 4px 6px -2px rgba(18, 21, 28, 0.5);

    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      font-family: 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace;
      background: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.6;
      min-height: 100vh;
    }

    .container {
      max-width: 1600px;
      margin: 0 auto;
      padding: 2rem;
      min-height: 100vh;
    }

    .header {
      text-align: center;
      margin-bottom: 3rem;
      padding: 2rem;
      background: var(--bg-card);
      border-radius: 16px;
      box-shadow: var(--shadow-lg);
      position: relative;
      overflow: hidden;
    }

    .strategy-desc { margin-top: .5rem; color: var(--text-secondary); font-size: .95rem; }

    .header::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 4px;
      background: var(--accent-primary);
    }

    .header h1 {
      font-size: 2.5rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
      color: var(--accent-primary);
    }

    .strategy-badge {
      display: inline-block;
      padding: 0.5rem 1.5rem;
      background: rgba(255, 204, 102, 0.2);
      border: 1px solid var(--accent-primary);
      border-radius: 50px;
      color: var(--accent-primary);
      font-weight: 500;
      font-size: 0.9rem;
    }

    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1.5rem;
      margin-bottom: 3rem;
    }

    .metric-card {
      background: var(--bg-card);
      border-radius: 12px;
      padding: 1.5rem;
      box-shadow: var(--shadow);
      border: 1px solid var(--border);
      transition: all 0.3s ease;
      position: relative;
      overflow: hidden;
    }

    .metric-card:hover {
      transform: translateY(-4px);
      box-shadow: var(--shadow-lg);
      background: var(--bg-card-hover);
    }

    .metric-card.positive::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: var(--success);
    }

    .metric-card.negative::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: var(--danger);
    }

    .metric-card.neutral::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: var(--accent-primary);
    }

    .metric-label {
      font-size: 0.875rem;
      color: var(--text-muted);
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.5rem;
    }

    .metric-value {
      font-size: 1.75rem;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 0.25rem;
    }

    .metric-value.positive { color: var(--success-soft); }
    .metric-value.negative { color: var(--danger-soft); }
    .metric-value.warning { color: var(--warning-soft); }

    .metric-subtitle {
      font-size: 0.75rem;
      color: var(--text-muted);
      font-weight: 400;
    }

    .section {
      margin-bottom: 3rem;
    }

    .section-title {
      font-size: 1.5rem;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 1.5rem;
      position: relative;
      padding-left: 1rem;
    }

    .section-title::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0.25rem;
      bottom: 0.25rem;
      width: 4px;
      background: var(--accent-primary);
      border-radius: 2px;
    }

    .exit-reasons {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 1rem;
      margin: 1.5rem 0;
    }

    .exit-reason {
      text-align: center;
      padding: 1rem;
      background: var(--bg-secondary);
      border-radius: 8px;
      border: 1px solid var(--border);
    }

    .exit-reason-count {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--accent-secondary);
    }

    .exit-reason-count.tp { color: #a3be8c; }
    .exit-reason-count.sl { color: #bf616a; }
    .exit-reason-count.timeout { color: #b48ead; }
    .exit-reason-count.end { color: var(--accent-secondary); }

    .exit-reason-label {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
    }

    .exit-explanation {
      margin-top: 1rem;
      padding: 1rem;
      background: var(--bg-tertiary);
      border-radius: 8px;
      border-left: 4px solid var(--accent-secondary);
    }

    .exit-explanation p {
      margin: 0;
      color: var(--text-secondary);
      font-size: 0.875rem;
      line-height: 1.5;
    }

    .table-container {
      background: var(--bg-secondary);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: var(--shadow);
      border: 1px solid var(--border);
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    thead {
      background: var(--bg-secondary);
    }

    th {
      padding: 1rem;
      text-align: left;
      font-weight: 600;
      color: var(--text-primary);
      font-size: 0.875rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-bottom: 2px solid var(--border);
    }

    td {
      padding: 0.875rem 1rem;
      border-bottom: 1px solid var(--border);
      font-size: 0.875rem;
    }

    tbody tr {
      transition: background-color 0.2s ease;
    }

    tbody tr:hover {
      background: rgba(255, 204, 102, 0.1);
    }

    tbody tr:last-child td {
      border-bottom: none;
    }

    .token-tag {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      background: rgba(92, 207, 230, 0.2);
      border: 1px solid var(--info);
      border-radius: 20px;
      color: var(--info);
      font-size: 0.75rem;
      font-weight: 500;
      font-family: 'Monaco', 'Consolas', monospace;
      white-space: nowrap;
      cursor: pointer;
    }

    .exit-badge {
      padding: 0.25rem 0.5rem;
      border-radius: 6px;
      font-size: 0.75rem;
      font-weight: 500;
    }

    .exit-badge.TP { background: rgba(135, 217, 108, 0.2); color: var(--success); }
    .exit-badge.SL { background: rgba(255, 102, 102, 0.2); color: var(--danger); }
    .exit-badge.TP_LOSS { background: rgba(255, 102, 102, 0.2); color: var(--danger); }
    .exit-badge.SL_WIN { background: rgba(135, 217, 108, 0.2); color: var(--success); }
    .exit-badge.TIMEOUT_WIN { background: rgba(135, 217, 108, 0.2); color: var(--success); }
    .exit-badge.TIMEOUT_LOSS { background: rgba(255, 102, 102, 0.2); color: var(--danger); }
    .exit-badge.END_WIN { background: rgba(135, 217, 108, 0.2); color: var(--success); }
    .exit-badge.END_LOSS { background: rgba(255, 102, 102, 0.2); color: var(--danger); }
    .exit-badge.TIMEOUT { background: rgba(242, 158, 116, 0.2); color: var(--warning); }
    .exit-badge.END { background: rgba(255, 204, 102, 0.2); color: var(--accent-primary); }

    .percentage {
      font-weight: 600;
    }

    .percentage.positive { color: var(--success-soft); }
    .percentage.negative { color: var(--danger-soft); }

    .files-section {
      text-align: center;
      margin-top: 2rem;
      padding: 1.5rem;
      background: var(--bg-secondary);
      border-radius: 8px;
      border: 1px solid var(--border);
    }

    .files-section a {
      color: var(--accent-secondary);
      text-decoration: none;
      font-weight: 500;
      margin: 0 1rem;
      transition: color 0.2s ease;
    }

    .files-section a:hover {
      color: var(--accent-primary);
      text-decoration: underline;
    }

    @media (max-width: 768px) {
      .container { padding: 1rem; }
      .header h1 { font-size: 2rem; }
      .metrics-grid { grid-template-columns: 1fr; }
      .metric-value { font-size: 1.5rem; }
      th, td { padding: 0.5rem; font-size: 0.8rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Wallet Backtest</h1>
      <div class="strategy-badge">Strategy: ${esc(strategyName || strategyId)}${strategyName ? ` (${esc(strategyId)})` : ""}</div>
      ${strategyDescription ? `<div class="strategy-desc">${esc(strategyDescription)}</div>` : ""}
    </div>

    <div class="metrics-grid">
      <div class="metric-card neutral">
        <div class="metric-label">Initial Capital</div>
        <div class="metric-value">${initialSol} SOL</div>
        <div class="metric-subtitle">Starting balance</div>
      </div>
      
      <div class="metric-card ${summary.totalReturn >= 0 ? "positive" : "negative"}">
        <div class="metric-label">Final Capital</div>
        <div class="metric-value ${summary.totalReturn >= 0 ? "positive" : "negative"}">${summary.finalSol} SOL</div>
        <div class="metric-subtitle">${summary.totalReturn >= 0 ? "+" : ""}${summary.totalReturn}% return</div>
      </div>
      
      <div class="metric-card neutral">
        <div class="metric-label">Total Trades</div>
        <div class="metric-value">${summary.trades}</div>
        <div class="metric-subtitle">${summary.wins}W / ${summary.losses}L</div>
      </div>
      
      <div class="metric-card ${summary.winRate >= 0.5 ? "positive" : "negative"}">
        <div class="metric-label">Win Rate</div>
        <div class="metric-value ${summary.winRate >= 0.5 ? "positive" : "negative"}">${(summary.winRate * 100).toFixed(1)}%</div>
        <div class="metric-subtitle">Success rate</div>
      </div>
      
      <div class="metric-card ${summary.profitFactor >= 1 ? "positive" : "negative"}">
        <div class="metric-label">Profit Factor</div>
        <div class="metric-value ${summary.profitFactor >= 1 ? "positive" : "negative"}">${summary.profitFactor}</div>
        <div class="metric-subtitle">Gains / Losses ratio</div>
      </div>
      
      <div class="metric-card ${summary.maxDrawdown <= 0.2 ? "positive" : summary.maxDrawdown <= 0.5 ? "warning" : "negative"}">
        <div class="metric-label">Max Drawdown</div>
        <div class="metric-value ${summary.maxDrawdown <= 0.2 ? "positive" : "negative"}">${(summary.maxDrawdown * 100).toFixed(1)}%</div>
        <div class="metric-subtitle">Maximum loss</div>
      </div>
      
      <div class="metric-card ${summary.avgWinningTrade > 0 ? "positive" : "neutral"}">
        <div class="metric-label">Average Win</div>
        <div class="metric-value positive">${summary.avgWinningTrade} SOL</div>
        <div class="metric-subtitle">Per winning trade</div>
      </div>
      
      <div class="metric-card ${summary.avgLosingTrade < 0 ? "negative" : "neutral"}">
        <div class="metric-label">Average Loss</div>
        <div class="metric-value negative">${summary.avgLosingTrade} SOL</div>
        <div class="metric-subtitle">Per losing trade</div>
      </div>
      
      <div class="metric-card positive">
        <div class="metric-label">Largest Win</div>
        <div class="metric-value positive">${summary.largestWin} SOL</div>
        <div class="metric-subtitle">Best single trade</div>
      </div>
      
      <div class="metric-card negative">
        <div class="metric-label">Largest Loss</div>
        <div class="metric-value negative">${summary.largestLoss} SOL</div>
        <div class="metric-subtitle">Worst single trade</div>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">Exit Reasons Distribution</h2>
      <div class="exit-reasons">
        ${Object.entries(summary.exitReasons)
			.map(([reason, count]) => {
				const reasonLabels = {
					TP: "Take Profit (Win)",
					SL: "Stop Loss (Loss)",
					TP_LOSS: "Take Profit (Loss)",
					SL_WIN: "Stop Loss (Win)",
					TIMEOUT_WIN: "Timeout (Win)",
					TIMEOUT_LOSS: "Timeout (Loss)",
					END_WIN: "Session End (Win)",
					END_LOSS: "Session End (Loss)",
					// Legacy support for old format
					TIMEOUT: "Timeout",
					END: "Session End",
				};
				// Determine CSS class based on reason
				let reasonClass = "end"; // default
				if (reason === "TP" || reason === "TIMEOUT_WIN" || reason === "END_WIN" || reason === "SL_WIN") {
					reasonClass = "tp"; // green for wins
				} else if (reason === "SL" || reason === "TIMEOUT_LOSS" || reason === "END_LOSS" || reason === "TP_LOSS") {
					reasonClass = "sl"; // red for losses
				} else if (reason === "TIMEOUT") {
					reasonClass = "timeout"; // purple for legacy timeout
				}

				return `<div class="exit-reason">
            <div class="exit-reason-count ${reasonClass}">${count}</div>
            <div class="exit-reason-label">${reasonLabels[reason] || reason}</div>
          </div>`;
			})
			.join("")}
      </div>
      <div class="exit-explanation">
        <p><strong>New Exit Classification:</strong> Exit reasons now reflect actual profitability after fees. 
        <strong>TP (Win)</strong> = Take profit signal that was actually profitable. 
        <strong>TP (Loss)</strong> = Take profit signal that lost money due to fees/slippage.
        <strong>SL (Win)</strong> = Stop loss signal that somehow ended profitable.
        <strong>Timeout/End (Win/Loss)</strong> = Session timeouts or natural endings classified by final profitability.</p>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">Configuration Parameters</h2>
      <div class="metrics-grid">
        <div class="metric-card neutral">
          <div class="metric-label">Fixed Allocation</div>
          <div class="metric-value">${allocSol} SOL</div>
        </div>
        <div class="metric-card neutral">
          <div class="metric-label">Percentage Allocation</div>
          <div class="metric-value">${(allocPct * 100).toFixed(0)}%</div>
        </div>
        <div class="metric-card positive">
          <div class="metric-label">Take Profit</div>
          <div class="metric-value">${tpPct}%</div>
        </div>
        <div class="metric-card negative">
          <div class="metric-label">Stop Loss</div>
          <div class="metric-value">${slPct}%</div>
        </div>
        <div class="metric-card warning">
          <div class="metric-label">Timeout</div>
          <div class="metric-value">${timeoutSec}s</div>
        </div>
        <div class="metric-card neutral">
          <div class="metric-label">Trading Fee</div>
          <div class="metric-value">${feePct}%</div>
        </div>
        <div class="metric-card neutral">
          <div class="metric-label">Slippage</div>
          <div class="metric-value">${slippagePct}%</div>
        </div>
        <div class="metric-card neutral">
          <div class="metric-label">Portal Fee (lado)</div>
          <div class="metric-value">${portalFeePct}% <span style="color:var(--text-muted);font-size:0.85em">(${apiType})</span></div>
        </div>
        <div class="metric-card neutral">
          <div class="metric-label">Fixed Fees (SOL)</div>
          <div class="metric-value">${entryFixedFeesSol} / ${exitFixedFeesSol}</div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">Trade Details</h2>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Token</th>
              <th>Exit Reason</th>
              <th>Time (s)</th>
              <th>Exit %</th>
              <th>Net %</th>
              <th>Allocation</th>
          <th>PnL (SOL)</th>
          <th>Wallet (SOL)</th>
          <th>Started</th>
          <th>Ended</th>
            </tr>
          </thead>
          <tbody>
            ${trades
				.map((t) => {
					const exitPctClass = t.exitPct >= 0 ? "positive" : "negative";
					const netPctClass = t.netPct >= 0 ? "positive" : "negative";
					const pnlClass = t.pnl >= 0 ? "positive" : "negative";
					const reasonLabels = {
						TP: "Take Profit",
						SL: "Stop Loss",
						TP_LOSS: "TP (Loss)",
						SL_WIN: "SL (Win)",
						TIMEOUT_WIN: "Timeout (Win)",
						TIMEOUT_LOSS: "Timeout (Loss)",
						END_WIN: "End (Win)",
						END_LOSS: "End (Loss)",
						// Legacy support
						TIMEOUT: "Timeout",
						END: "Session End",
					};
					return `<tr>
                <td><span class="token-tag" data-token="${esc(t.token)}" data-display="${esc((t.token || "").length > 10 ? t.token.slice(0, 4) + "..." + t.token.slice(-6) : t.token)}" title="${esc(t.token)}">${esc((t.token || "").length > 10 ? t.token.slice(0, 4) + "..." + t.token.slice(-6) : t.token)}</span></td>
                <td><span class="exit-badge ${t.exitReason}">${reasonLabels[t.exitReason] || esc(t.exitReason)}</span></td>
                <td>${t.tExit}</td>
                <td><span class="percentage ${exitPctClass}">${toFixed(t.exitPct, 2)}%</span></td>
                <td><span class="percentage ${netPctClass}">${toFixed(t.netPct, 2)}%</span></td>
                <td>${toFixed(t.alloc, 4)} SOL</td>
                <td><span class="percentage ${pnlClass}">${toFixed(t.pnl, 6)}</span></td>
                <td>${toFixed(t.walletAfter, 6)}</td>
                <td>${esc(t.startedAt ? new Date(t.startedAt).toLocaleString("en-US") : "")}</td>
                <td>${esc(t.endedAt ? new Date(t.endedAt).toLocaleString("en-US") : "")}</td>
              </tr>`;
				})
				.join("")}
          </tbody>
        </table>
      </div>
    </div>

    <div class="files-section">
      <strong>Generated Files:</strong>
      <a href="trades.csv">trades.csv</a>
      <a href="summary.json">summary.json</a>
    </div>
  </div>
  <script>
    document.addEventListener('click', function(e){
      const tag = e.target.closest('.token-tag');
      if(!tag) return;
      const token = tag.getAttribute('data-token');
      const display = tag.getAttribute('data-display') || tag.textContent;
      if(!token) return;
      const onDone = () => {
        const old = tag.textContent;
        tag.textContent = 'Copied!';
        setTimeout(()=>{ tag.textContent = display; }, 800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(token).then(onDone).catch(()=>{
          try {
            const ta = document.createElement('textarea');
            ta.value = token; document.body.appendChild(ta); ta.select();
            document.execCommand('copy'); document.body.removeChild(ta);
          } catch {}
          onDone();
        });
      } else {
        try {
          const ta = document.createElement('textarea');
          ta.value = token; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta);
        } catch {}
        onDone();
      }
    });
  </script>
</body>
</html>`;
	fs.writeFileSync(path.join(OUTPUT_DIR, "report.html"), html, "utf8");

	const totalSec = ((Date.now() - startTs) / 1000).toFixed(1);
	console.log("Wallet backtest completado.");
	if (trades.length > 0) {
		const winRatePct = ((wins / trades.length) * 100).toFixed(2);
		console.log(
			`Resumen: trades=${trades.length}, wins=${wins}, losses=${losses}, winRate=${winRatePct}%, final=${toFixed(wallet, 6)} SOL, maxDD=${(maxDrawdown * 100).toFixed(2)}%, duración=${totalSec}s`
		);
		try {
			console.log(`[Wallet] Razones de salida: ${JSON.stringify(summary.exitReasons)}`);
		} catch (error) {
			// Ignore JSON serialization errors
		}
	}
	console.log(`Salida: ${OUTPUT_DIR}/trades.csv, summary.json, report.html`);
}

main().catch((e) => {
	console.error("Error en wallet-backtest:", e);
	process.exit(1);
});
