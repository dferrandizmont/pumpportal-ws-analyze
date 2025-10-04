#!/usr/bin/env node

import http from "http";

// --- Formatting helpers (ES-ES, 24h, sin librerías externas) ---
const ES_LOCALE = "es-ES";

/**
 * Get heat level based on tokens per minute rate
 * @param {number} rate - Tokens per minute
 * @returns {object} - { icon, label, color }
 */
function getHeatLevel(rate) {
	if (rate === 0 || !isFinite(rate)) {
		return { icon: "❄️ ", label: "FREEZE", color: "\x1b[36m", bar: "░" }; // Cyan
	} else if (rate < 1) {
		return { icon: "🧊", label: "COLD", color: "\x1b[34m", bar: "▒" }; // Blue
	} else if (rate < 2) {
		return { icon: "⚪", label: "NEUTRAL", color: "\x1b[37m", bar: "▓" }; // White
	} else if (rate < 4) {
		return { icon: "🔥", label: "HOT", color: "\x1b[33m", bar: "█" }; // Yellow
	} else {
		return { icon: "🌋", label: "BURNING", color: "\x1b[31m", bar: "█" }; // Red
	}
}

/**
 * Create a visual bar chart for token creation rate
 * @param {number} rate - Tokens per minute
 * @param {number} maxWidth - Maximum width of the bar
 * @returns {string} - Visual bar representation
 */
function createRateBar(rate, maxWidth = 40) {
	const heat = getHeatLevel(rate);
	const normalizedRate = Math.min(rate / 6, 1); // Normalize to 0-1 (6+ tokens/min = max)
	const filledWidth = Math.floor(normalizedRate * maxWidth);
	const emptyWidth = maxWidth - filledWidth;
	
	const resetColor = "\x1b[0m";
	return heat.color + heat.bar.repeat(filledWidth) + resetColor + "░".repeat(emptyWidth);
}

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

// Sell state by agreed rules
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
	console.info("\n🔥 ═══ TRACKED TOKENS STATUS ═══ 🔥");
	console.info(`⏰ Date: ${formatDateTimeEs(data.timestamp)}`);
	console.info(`⏱️  Uptime: ${formatDurationHMS(data.uptime)}`);
	if (data.solUsdPrice) {
		const last = data.solUsdLastUpdated ? formatDateTimeEs(data.solUsdLastUpdated) : "N/A";
		console.info(`💱 SOL/USD: ${formatCurrencyUsdEs(data.solUsdPrice)} (updated: ${last})`);
	}
	const threshold = data.creatorSellThreshold ?? 80;
	console.info(`🎯 Monitored: ${data.tokens.length}\n`);

	data.tokens.forEach((token, index) => {
		const sellPct = token.sellPercentage || 0;
		const state = getSellState(sellPct, threshold);

		console.info(`${index + 1}. ${state.icon} ${state.label} · ${token.name} (${token.symbol})`);
		console.info(`   🔗 Address: ${token.address}`);
		console.info(`   👤 Creator: ${token.creator}`);
		console.info(`   💰 Holds: ${formatNumberEs(token.totalTokensOwned || 0)} tokens`);
		console.info(`   📤 Sold: ${formatNumberEs(token.tokensSold || 0)} tokens`);
		console.info(`   📊 Sold %: ${formatPercentEs(sellPct)} ${sellPct >= threshold && sellPct < 100 ? "🟧" : sellPct === 100 ? "🏁" : sellPct === 0 ? "🟢" : "🟨"}`);
		const lastSellStr = token.lastSellTime ? formatTimeEs(token.lastSellTime) : "Never";
		// T+ context in seconds since creation if there's a last sale
		let tPlus = "";
		if (token.lastSellTime && token.createdAt) {
			const deltaSec = Math.max(0, Math.floor((new Date(token.lastSellTime) - new Date(token.createdAt)) / 1000));
			tPlus = ` (T+${deltaSec} s)`;
		}
		console.info(`   ⏰ Last sale: ${lastSellStr}${tPlus}`);
		console.info(`   📋 # sales: ${token.totalSells}`);
		console.info(`   🎂 Created: ${formatDateTimeEs(token.createdAt)}`);
		console.info("");
	});

	console.info("═════════════════════════════════════════════\n");
}

function formatStats(data) {
	const resetColor = "\x1b[0m";
	const cyan = "\x1b[36m";
	const yellow = "\x1b[33m";
	const green = "\x1b[32m";
	const red = "\x1b[31m";
	const blue = "\x1b[34m";
	const magenta = "\x1b[35m";
	const white = "\x1b[1m";
	const gray = "\x1b[90m";
	
	const separator = "═".repeat(80);
	const thinSeparator = "─".repeat(80);
	
	console.info("\n" + cyan + separator + resetColor);
	console.info(white + "🚀 PUMPPORTAL TOKEN ANALYZER · LIVE DASHBOARD 🚀" + resetColor);
	console.info(cyan + separator + resetColor);
	
	// System Info Section
	console.info(`${gray}⏰ Timestamp:${resetColor}        ${formatDateTimeEs(data.timestamp)}`);
	console.info(`${gray}⚡ Uptime:${resetColor}           ${green}${formatDurationHMS(data.uptime)}${resetColor}`);
	
	if (typeof data.solUsdPrice === "number") {
		const last = data.solUsdLastUpdated ? formatDateTimeEs(data.solUsdLastUpdated) : "N/A";
		console.info(`${gray}💱 SOL/USD:${resetColor}          ${yellow}${formatCurrencyUsdEs(data.solUsdPrice)}${resetColor} (updated: ${last})`);
	}
	
	console.info("\n" + cyan + separator + resetColor);
	console.info(white + "📊 TOKEN METRICS" + resetColor);
	console.info(cyan + separator + resetColor);
	
	const threshold = data.creatorSellThreshold ?? 80;
	const totalTokens = data.totalTokens || 0;
	const tokensOverThreshold = data.tokensOverThreshold || 0;
	const avgSell = data.averageSellPercentage || 0;
	const overPct = totalTokens > 0 ? (tokensOverThreshold / totalTokens) * 100 : 0;
	const distToThr = Math.max(0, threshold - avgSell);
	
	console.info(`${gray}🎯 Monitored Tokens:${resetColor}     ${white}${totalTokens}${resetColor}`);
	console.info(`${gray}👥 Unique Creators:${resetColor}      ${white}${data.totalCreators || 0}${resetColor}`);
	
	const riskColor = overPct > 70 ? red : overPct > 40 ? yellow : green;
	console.info(`${gray}🟧 Over Threshold:${resetColor}       ${riskColor}${tokensOverThreshold}/${totalTokens} (${formatPercentEs(overPct, 1)})${resetColor} ${gray}(≥${threshold}%)${resetColor}`);
	console.info(`${gray}📈 Avg Creator Sell:${resetColor}     ${white}${formatPercentEs(avgSell)}${resetColor}${distToThr > 0 ? gray + ` (-${formatNumberEs(distToThr, { maximumFractionDigits: 1 })} pp to threshold)` + resetColor : ""}`);
	
	// Token Creation Rate - NEW FEATURE
	if (data.tokenCreationRate) {
		const rate = data.tokenCreationRate;
		const tokensPerMin = rate.tokensPerMinute || 0;
		const heat = getHeatLevel(tokensPerMin);
		
		console.info("\n" + cyan + separator + resetColor);
		console.info(white + "🔥 TOKEN CREATION RATE" + resetColor);
		console.info(cyan + separator + resetColor);
		
		console.info(`${gray}📊 Rate (5min avg):${resetColor}      ${heat.color}${heat.icon} ${formatNumberEs(tokensPerMin, { maximumFractionDigits: 2 })} tokens/min ${heat.label}${resetColor}`);
		console.info(`${gray}⏱️  Last Minute:${resetColor}         ${white}${rate.tokensLastMinute || 0} tokens${resetColor}`);
		console.info(`${gray}⏳ Last 5 Minutes:${resetColor}       ${white}${rate.tokensLast5Minutes || 0} tokens${resetColor}`);
		
		// Visual bar
		const bar = createRateBar(tokensPerMin, 70);
		console.info(`${gray}   Activity:${resetColor}           ${bar}`);
	}
	
	console.info("\n" + cyan + separator + resetColor);
	console.info(white + "🧭 DISTRIBUTION BY STATE" + resetColor);
	console.info(cyan + separator + resetColor);
	
	// Distribution by state
	if (data.states) {
		const s = data.states;
		const total = (s.safe ?? 0) + (s.watch ?? 0) + (s.risk ?? 0) + (s.exited ?? 0);
		const safePct = total > 0 ? ((s.safe ?? 0) / total * 100) : 0;
		const watchPct = total > 0 ? ((s.watch ?? 0) / total * 100) : 0;
		const riskPct = total > 0 ? ((s.risk ?? 0) / total * 100) : 0;
		const exitPct = total > 0 ? ((s.exited ?? 0) / total * 100) : 0;
		
		console.info(`${green}🟢 SAFE${resetColor} ${gray}(0%)${resetColor}                    ${white}${s.safe ?? 0}${resetColor} ${gray}(${formatPercentEs(safePct, 1)})${resetColor}`);
		console.info(`${yellow}🟨 WATCH${resetColor} ${gray}(>0%, <${threshold}%)${resetColor}         ${white}${s.watch ?? 0}${resetColor} ${gray}(${formatPercentEs(watchPct, 1)})${resetColor}`);
		console.info(`${red}🟧 RISK${resetColor} ${gray}(≥${threshold}%, <100%)${resetColor}        ${white}${s.risk ?? 0}${resetColor} ${gray}(${formatPercentEs(riskPct, 1)})${resetColor}`);
		console.info(`${gray}🏁 EXITED${resetColor} ${gray}(100%)${resetColor}               ${white}${s.exited ?? 0}${resetColor} ${gray}(${formatPercentEs(exitPct, 1)})${resetColor}`);
	}
	
	// Alerts section
	if (data.alerts) {
		const a = data.alerts;
		console.info("\n" + cyan + separator + resetColor);
		console.info(white + "🚨 ALERTS & EXITS" + resetColor);
		console.info(cyan + separator + resetColor);
		
		console.info(`${gray}📢 Alerted Tokens:${resetColor}       ${red}${a.alertedTokens ?? 0}${resetColor}`);
		console.info(`${gray}🏁 Fully Exited:${resetColor}         ${white}${a.fullyExitedTokens ?? 0}${resetColor}`);
		
		if (a.fullyExitedTokens > 0) {
			const exitAvgUsd = typeof a.avgExitMarketCapUsd === "number" && isFinite(a.avgExitMarketCapUsd) 
				? formatCurrencyUsdEs(a.avgExitMarketCapUsd) 
				: "N/A";
			const exitSumUsd = typeof a.sumExitMarketCapUsd === "number" && isFinite(a.sumExitMarketCapUsd) 
				? formatCurrencyUsdEs(a.sumExitMarketCapUsd) 
				: "N/A";
			
			console.info(`${gray}💰 Avg Exit MC:${resetColor}          ${yellow}${exitAvgUsd}${resetColor}`);
			console.info(`${gray}💵 Total Exit MC:${resetColor}        ${yellow}${exitSumUsd}${resetColor}`);
		}
	}
	
	// WebSocket Info
	console.info("\n" + cyan + separator + resetColor);
	console.info(white + "🔌 WEBSOCKET STATUS" + resetColor);
	console.info(cyan + separator + resetColor);
	
	if (data.subscriptions) {
		const sub = data.subscriptions;
		const wsStatus = sub.wsConnected ? green + "🟢 CONNECTED" + resetColor : red + "🔴 DISCONNECTED" + resetColor;
		console.info(`${gray}Status:${resetColor}               ${wsStatus}`);
		console.info(`${gray}📊 Subscribed Tokens:${resetColor}    ${white}${sub.currentTokens || 0}${resetColor}`);
		console.info(`${gray}👤 Subscribed Accounts:${resetColor}  ${white}${sub.currentAccounts || 0}${resetColor}`);
		console.info(`${gray}📈 Total Historical:${resetColor}     ${white}${data.subscriptionStats?.totalTokensEverSubscribed || 0}${resetColor}`);
	}
	
	// Tracking section - ALWAYS show
	if (data.tracking) {
		console.info("\n" + cyan + separator + resetColor);
		console.info(white + "🧪 ACTIVE TRACKING" + resetColor);
		console.info(cyan + separator + resetColor);
		
		const t = data.tracking;
		console.info(`${gray}Active Tokens:${resetColor}         ${magenta}${t.totalActiveTokens ?? 0}${resetColor}`);
		console.info(`${gray}Active Sessions:${resetColor}       ${magenta}${t.totalActiveSessions ?? 0}${resetColor}`);
		
		if (t.byStrategy && typeof t.byStrategy === "object") {
			console.info(`\n${gray}${thinSeparator}${resetColor}`);
			const entries = Object.entries(t.byStrategy).sort((a, b) => a[0].localeCompare(b[0]));
			for (const [sid, v] of entries) {
				const avgMax = typeof v.avgMaxPct === "number" && isFinite(v.avgMaxPct) ? formatPercentEs(v.avgMaxPct) : "N/A";
				const avgMin = typeof v.avgMinPct === "number" && isFinite(v.avgMinPct) ? formatPercentEs(v.avgMinPct) : "N/A";
				console.info(`${blue}• ${sid}${resetColor}`);
				console.info(`  ${gray}sessions=${v.sessions ?? 0}, entries=${v.entriesRecorded ?? 0}, no-trades=${v.noPostTrades ?? 0}, trades=${v.tradeCountTotal ?? 0}${resetColor}`);
				console.info(`  ${gray}avgMax=${avgMax}, avgMin=${avgMin}${resetColor}`);
			}
		}
	}
	
	console.info(cyan + separator + resetColor);
	console.info("");
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
