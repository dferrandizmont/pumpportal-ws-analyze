#!/usr/bin/env node

import http from "http";

// --- Formatting helpers (ES-ES, 24h, sin librerías externas) ---
const ES_LOCALE = "es-ES";

function formatNumberEs(value, options = {}) {
	const { minimumFractionDigits, maximumFractionDigits } = options;
	if (typeof value !== "number" || !isFinite(value)) return "0";
	return value.toLocaleString(ES_LOCALE, {
		minimumFractionDigits,
		maximumFractionDigits,
	});
}

function formatPercentEs(value, digits = 2) {
	const n = typeof value === "number" ? value : 0;
	return `${n.toFixed(digits).replace(".", ",")} %`;
}

function formatCurrencyUsdEs(value) {
	if (typeof value !== "number" || !isFinite(value)) return "0,00 $";
	return `${formatNumberEs(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
}

function formatDateTimeEs(dateLike) {
	const d = new Date(dateLike);
	if (isNaN(d)) return "N/D";
	return d.toLocaleString(ES_LOCALE, {
		year: "2-digit",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

function formatTimeEs(dateLike) {
	const d = new Date(dateLike);
	if (isNaN(d)) return "N/D";
	return d.toLocaleTimeString(ES_LOCALE, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

function formatDurationHMS(totalSeconds) {
	const s = Math.max(0, Math.floor(totalSeconds || 0));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const pad = (n) => n.toString().padStart(2, "0");
	return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

// Estados de venta por reglas acordadas
function getSellState(percentage, threshold = 80) {
	if (!isFinite(percentage)) percentage = 0;
	if (percentage === 0) return { icon: "🟢", label: "SAFE" };
	if (percentage === 100) return { icon: "🏁", label: "EXITED" };
	if (percentage >= threshold) return { icon: "🟧", label: "RISK" };
	return { icon: "🟨", label: "WATCH" };
}

/**
 * Client script to query PumpPortal Token Analyzer status from another terminal
 * Usage: node status-client.js [command] [options]
 *
 * Commands:
 *   status  - Get detailed token tracking status
 *   stats   - Get quick statistics
 *   health  - Health check
 *   watch   - Continuously monitor stats
 */

const PORT = process.env.HTTP_PORT || 3012;
const HOST = "localhost";

function makeRequest(endpoint) {
	return new Promise((resolve, reject) => {
		const options = {
			hostname: HOST,
			port: PORT,
			path: `/${endpoint}`,
			method: "GET",
			headers: {
				"Content-Type": "application/json",
			},
		};

		const req = http.request(options, (res) => {
			let data = "";

			res.on("data", (chunk) => {
				data += chunk;
			});

			res.on("end", () => {
				try {
					if (res.statusCode === 200) {
						const jsonData = JSON.parse(data);
						resolve(jsonData);
					} else {
						reject(new Error(`HTTP ${res.statusCode}: ${data}`));
					}
				} catch (error) {
					reject(new Error(`Failed to parse response: ${error.message}`));
				}
			});
		});

		req.on("error", (error) => {
			reject(new Error(`Request failed: ${error.message}`));
		});

		req.setTimeout(5000, () => {
			req.destroy();
			reject(new Error("Request timeout"));
		});

		req.end();
	});
}

function formatStatus(data) {
	console.info("\n🔥 ═══ ESTADO DE TOKENS TRACKED ═══ 🔥");
	console.info(`⏰ Fecha: ${formatDateTimeEs(data.timestamp)}`);
	console.info(`⏱️  Uptime: ${formatDurationHMS(data.uptime)}`);
	if (data.solUsdPrice) {
		const last = data.solUsdLastUpdated ? formatDateTimeEs(data.solUsdLastUpdated) : "N/D";
		console.info(`💱 SOL/USD: ${formatCurrencyUsdEs(data.solUsdPrice)} (act.: ${last})`);
	}
	const threshold = data.creatorSellThreshold ?? 80;
	console.info(`🎯 Monitoreados: ${data.tokens.length}\n`);

	data.tokens.forEach((token, index) => {
		const sellPct = token.sellPercentage || 0;
		const state = getSellState(sellPct, threshold);

		console.info(`${index + 1}. ${state.icon} ${state.label} · ${token.name} (${token.symbol})`);
		console.info(`   🔗 Address: ${token.address}`);
		console.info(`   👤 Creador: ${token.creator}`);
		console.info(`   💰 Posee: ${formatNumberEs(token.totalTokensOwned || 0)} tokens`);
		console.info(`   📤 Vendidos: ${formatNumberEs(token.tokensSold || 0)} tokens`);
		console.info(`   📊 Vendido: ${formatPercentEs(sellPct)} ${sellPct >= threshold && sellPct < 100 ? "🟧" : sellPct === 100 ? "🏁" : sellPct === 0 ? "🟢" : "🟨"}`);
		const lastSellStr = token.lastSellTime ? formatTimeEs(token.lastSellTime) : "Nunca";
		// Contexto T+segundos desde la creación si hay última venta
		let tPlus = "";
		if (token.lastSellTime && token.createdAt) {
			const deltaSec = Math.max(0, Math.floor((new Date(token.lastSellTime) - new Date(token.createdAt)) / 1000));
			tPlus = ` (T+${deltaSec} s)`;
		}
		console.info(`   ⏰ Última venta: ${lastSellStr}${tPlus}`);
		console.info(`   📋 Nº ventas: ${token.totalSells}`);
		console.info(`   🎂 Creado: ${formatDateTimeEs(token.createdAt)}`);
		console.info("");
	});

	console.info("═════════════════════════════════════════════\n");
}

function formatStats(data) {
	console.info("\n📊 ═══ PumpPortal · Live ═══ 📊");
	console.info(`⏰ Fecha: ${formatDateTimeEs(data.timestamp)}`);
	console.info(`⚡ Uptime: ${formatDurationHMS(data.uptime)}`);

	if (typeof data.solUsdPrice === "number") {
		const last = data.solUsdLastUpdated ? formatDateTimeEs(data.solUsdLastUpdated) : "N/D";
		console.info(`💱 SOL/USD: ${formatCurrencyUsdEs(data.solUsdPrice)} (act.: ${last})`);
	}

	const threshold = data.creatorSellThreshold ?? 80;
	const totalTokens = data.totalTokens || 0;
	const tokensOverThreshold = data.tokensOverThreshold || 0;
	const avgSell = data.averageSellPercentage || 0;

	const overPct = totalTokens > 0 ? (tokensOverThreshold / totalTokens) * 100 : 0;
	const distToThr = Math.max(0, threshold - avgSell);

	console.info(`🎯 Monitoreados: ${totalTokens}`);
	console.info(`👥 Creadores: ${data.totalCreators || 0}`);
	console.info(`🟧 Sobre umbral (≥${threshold} %): ${tokensOverThreshold}/${totalTokens} (${formatPercentEs(overPct, 1)})`);
	console.info(`📦 Tenencia total: ${formatNumberEs(data.totalTokensOwned || 0, { maximumFractionDigits: 3 })}`);
	console.info(`📤 Vendidos total: ${formatNumberEs(data.totalTokensSold || 0, { maximumFractionDigits: 3 })}`);
	console.info(`📈 Venta media creador: ${formatPercentEs(avgSell)}${distToThr > 0 ? ` (a ${formatNumberEs(distToThr, { maximumFractionDigits: 2 })} p. p. del umbral)` : ""}`);
	console.info(`🎚️  Umbral de venta creador: ${formatPercentEs(threshold, 0)}`);

	// Información de suscripciones WebSocket
	if (data.subscriptions) {
		const sub = data.subscriptions;
		const wsIcon = sub.wsConnected ? "🟢" : "🔴";
		console.info(
			`🔌 WebSocket: ${wsIcon} ${sub.wsConnected ? "Conectado" : "Desconectado"} · Tokens actuales: ${sub.currentTokens || 0} · Total histórico: ${data.subscriptionStats?.totalTokensEverSubscribed || 0} · Cuentas suscritas: ${sub.currentAccounts || 0} · Total suscripciones: ${sub.totalSubscribed || 0}`
		);
	}

	// Estadísticas históricas de suscripciones
	if (data.subscriptionStats) {
		const stats = data.subscriptionStats;
		console.info(
			`📊 Histórico: tokens detectados=${stats.totalNewTokensDetected || 0} · tokens suscritos=${stats.totalTokensEverSubscribed || 0} · sesiones tracking=${stats.totalTrackingSessionsStarted || 0}`
		);
	}

	// Distribución por estado (si disponible)
	if (data.states) {
		const s = data.states;
		console.info(`🧭 Estados: 🟢 SAFE: ${s.safe ?? 0}  ·  🟨 WATCH: ${s.watch ?? 0}  ·  🟧 RISK: ${s.risk ?? 0}  ·  🏁 EXITED: ${s.exited ?? 0}`);
	}

	// Métricas de alertas y salidas
	if (data.alerts) {
		const a = data.alerts;
		const exitAvgUsd = typeof a.avgExitMarketCapUsd === "number" && isFinite(a.avgExitMarketCapUsd) ? formatCurrencyUsdEs(a.avgExitMarketCapUsd) : "N/D";
		const exitSumUsd = typeof a.sumExitMarketCapUsd === "number" && isFinite(a.sumExitMarketCapUsd) ? formatCurrencyUsdEs(a.sumExitMarketCapUsd) : "N/D";
		const exitSumSol =
			typeof a.sumExitMarketCapSol === "number" && isFinite(a.sumExitMarketCapSol) ? `${formatNumberEs(a.sumExitMarketCapSol, { maximumFractionDigits: 6 })} SOL` : "N/D";
		console.info(
			`🚨 Alertas: disparadas=${a.alertedTokens ?? 0} · salidas=${a.fullyExitedTokens ?? 0} · MC salida media=${exitAvgUsd} · MC salida total=${exitSumUsd} (${exitSumSol})`
		);
	}

	// Tracking activo por estrategia
	if (data.tracking) {
		const t = data.tracking;
		console.info(`🧪 Tracking activo: tokens=${t.totalActiveTokens ?? 0} · sesiones=${t.totalActiveSessions ?? 0}`);
		if (t.byStrategy && typeof t.byStrategy === "object") {
			const entries = Object.entries(t.byStrategy).sort((a, b) => a[0].localeCompare(b[0]));
			for (const [sid, v] of entries) {
				const avgMax = typeof v.avgMaxPct === "number" && isFinite(v.avgMaxPct) ? formatPercentEs(v.avgMaxPct) : "N/D";
				const avgMin = typeof v.avgMinPct === "number" && isFinite(v.avgMinPct) ? formatPercentEs(v.avgMinPct) : "N/D";
				console.info(
					`   • ${sid}: sesiones=${v.sessions ?? 0}, entradas=${v.entriesRecorded ?? 0}, sin-trades=${v.noPostTrades ?? 0}, trades=${v.tradeCountTotal ?? 0}, avgMax=${avgMax}, avgMin=${avgMin}`
				);
			}
		}
	}
	console.info("═════════════════════════════════════════════\n");
}

function formatHealth(data) {
	const statusIcon = data.status === "healthy" ? "✅" : "❌";
	const runningIcon = data.isRunning ? "🟢" : "🔴";

	console.info("\n🏥 ═══ HEALTH CHECK ═══ 🏥");
	console.info(`${statusIcon} Status: ${data.status.toUpperCase()}`);
	console.info(`⏰ Timestamp: ${new Date(data.timestamp).toLocaleString()}`);
	console.info(`⚡ Uptime: ${Math.floor(data.uptime / 60)}m ${Math.floor(data.uptime % 60)}s`);
	console.info(`${runningIcon} Is running: ${data.isRunning ? "YES" : "NO"}`);
	console.info("═══════════════════════════════\n");
}

async function watchMode(interval = 5000) {
	console.info(`👀 Entering watch mode (updates every ${interval / 1000}s). Press Ctrl+C to exit.\n`);

	const watchInterval = setInterval(async () => {
		try {
			const data = await makeRequest("stats");
			console.clear();
			formatStats(data);
		} catch (error) {
			console.error(`❌ Error: ${error.message}`);
		}
	}, interval);

	// Handle Ctrl+C
	process.on("SIGINT", () => {
		console.info("\n👋 Exiting watch mode...");
		clearInterval(watchInterval);
		process.exit(0);
	});
}

async function main() {
	const args = process.argv.slice(2);
	const command = args[0] || "help";

	try {
		switch (command) {
			case "status": {
				const statusData = await makeRequest("status");
				formatStatus(statusData);
				break;
			}

			case "stats": {
				const statsData = await makeRequest("stats");
				formatStats(statsData);
				break;
			}

			case "health": {
				const healthData = await makeRequest("health");
				formatHealth(healthData);
				break;
			}

			case "watch": {
				const interval = args[1] ? parseInt(args[1]) * 1000 : 5000;
				await watchMode(interval);
				break;
			}

			case "help":
			default:
				console.info("\n🚀 ═══ PUMPPORTAL TOKEN ANALYZER - STATUS CLIENT ═══ 🚀");
				console.info("═══════════════════════════════════════════════════════════");
				console.info("");
				console.info("📋 Usage: node status-client.js <command> [options]");
				console.info("");
				console.info("🔧 Commands:");
				console.info("  📊 status              Show detailed token tracking status");
				console.info("  📈 stats               Show quick statistics");
				console.info("  🏥 health              Health check");
				console.info("  👀 watch [seconds]     Continuously monitor stats (default: 5s)");
				console.info("  ❓ help                Show this help message");
				console.info("");
				console.info("💡 Examples:");
				console.info("  🔹 node status-client.js status");
				console.info("  🔹 node status-client.js stats");
				console.info("  🔹 node status-client.js watch 10");
				console.info("");
				console.info("⚙️  Environment Variables:");
				console.info("  🌐 HTTP_PORT           Port where the main app is running (default: 3012)");
				console.info("");
				console.info("═══════════════════════════════════════════════════════════\n");
				break;
		}
	} catch (error) {
		console.error(`❌ Error: ${error.message}`);
		console.info("\n🔧 Make sure the main PumpPortal application is running on port", PORT);
		console.info("   🚀 Start it with: yarn start");
		process.exit(1);
	}
}

if (import.meta.url === (process?.argv?.[1] ? new URL(`file://${process.argv[1]}`).href : "")) {
	main();
}

export { makeRequest, formatStatus, formatStats, formatHealth };
