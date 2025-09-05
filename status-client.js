#!/usr/bin/env node

import http from "http";

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

const PORT = process.env.HTTP_PORT || 3000;
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
	console.info("\n🔥 ═══ PUMPPORTAL TOKEN TRACKING STATUS ═══ 🔥");
	console.info(`⏰ Timestamp: ${new Date(data.timestamp).toLocaleString()}`);
	console.info(`⏱️  Uptime: ${Math.floor(data.uptime / 60)}m ${Math.floor(data.uptime % 60)}s`);
	if (data.solUsdPrice) {
		const last = data.solUsdLastUpdated ? new Date(data.solUsdLastUpdated).toLocaleString() : "N/A";
		console.info(`💎 SOL/USD: $${data.solUsdPrice} (last updated: ${last})`);
	}
	const threshold = data.creatorSellThreshold ?? 80;
	console.info(`🎯 Total tokens monitored: ${data.tokens.length}\n`);

	data.tokens.forEach((token, index) => {
		const sellPct = token.sellPercentage || 0;
		const statusEmoji = sellPct >= 80 ? "🚨" : sellPct >= 50 ? "⚠️" : sellPct >= 25 ? "📊" : "🟢";
		const riskLevel = sellPct >= 80 ? "HIGH RISK" : sellPct >= 50 ? "MEDIUM RISK" : sellPct >= 25 ? "LOW RISK" : "SAFE";

		console.info(`${index + 1}. ${statusEmoji} ${token.name} (${token.symbol}) - ${riskLevel}`);
		console.info(`   🔗 Address: ${token.address}`);
		console.info(`   👤 Creator: ${token.creator}`);
		console.info(`   💰 Creator owns: ${(token.totalTokensOwned || 0).toLocaleString()} tokens`);
		console.info(`   📤 Creator sold: ${(token.tokensSold || 0).toLocaleString()} tokens`);
		console.info(`   📊 Sold percentage: ${sellPct.toFixed(2)}% ${sellPct >= threshold ? "🚨" : "✅"}`);
		console.info(`   ⏰ Last sell: ${token.lastSellTime ? new Date(token.lastSellTime).toLocaleTimeString() : "🕐 Never"}`);
		console.info(`   📋 Total sells: ${token.totalSells} ${token.totalSells > 5 ? "🔥" : ""}`);
		console.info(`   🎂 Created: ${new Date(token.createdAt).toLocaleString()}`);
		console.info("");
	});

	console.info("═════════════════════════════════════════════\n");
}

function formatStats(data) {
	console.info("\n📊 ═══ PUMPPORTAL LIVE STATISTICS ═══ 📊");
	console.info(`⏰ Timestamp: ${new Date(data.timestamp).toLocaleString()}`);
	console.info(`⚡ Uptime: ${Math.floor(data.uptime / 60)}m ${Math.floor(data.uptime % 60)}s`);

	if (data.solUsdPrice) {
		const last = data.solUsdLastUpdated ? new Date(data.solUsdLastUpdated).toLocaleString() : "N/A";
		console.info(`💎 SOL/USD: $${data.solUsdPrice} (updated: ${last})`);
	}

	const threshold = data.creatorSellThreshold ?? 80;
	const tokensOverThreshold = data.tokensOverThreshold || 0;
	const avgSell = data.averageSellPercentage || 0;

	console.info(`🎯 Tokens monitored: ${data.totalTokens}`);
	console.info(`👥 Total creators: ${data.totalCreators}`);
	console.info(`🚨 Tokens over threshold: ${tokensOverThreshold} ${tokensOverThreshold > 0 ? "⚠️" : "✅"}`);
	console.info(`💼 Total tokens owned: ${data.totalTokensOwned ? data.totalTokensOwned.toLocaleString() : "0"}`);
	console.info(`📤 Total tokens sold: ${data.totalTokensSold ? data.totalTokensSold.toLocaleString() : "0"}`);
	console.info(`📈 Average sell %: ${avgSell.toFixed(2)}% ${avgSell >= 50 ? "🔥" : avgSell >= 25 ? "⚠️" : "🟢"}`);
	console.info(`🎚️  Creator sell threshold: ${threshold}%`);
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
				console.info("  🌐 HTTP_PORT           Port where the main app is running (default: 3000)");
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
