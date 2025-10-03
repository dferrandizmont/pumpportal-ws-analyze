import http from "http";
import config from "../src/config.js";

const STATUS_URL = `http://localhost:${config.api.port}/status`;
const REFRESH_INTERVAL = 5000; // 5 seconds

let isRunning = true;

function formatDuration(seconds) {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	return `${h}h ${m}m`;
}

function displayDetailedDashboard(data) {
	console.clear();
	
	const uptime = formatDuration(Math.floor(data.uptime));
	const now = new Date().toLocaleTimeString();
	
	console.log("═".repeat(100));
	console.log("                       🎯 PUMPPORTAL MONITOR - DETAILED VIEW");
	console.log("═".repeat(100));
	console.log(`⏰ ${now} | 🟢 CONNECTED | Uptime: ${uptime}\n`);
	
	// Market Info
	console.log("💰 MARKET INFO");
	console.log("─".repeat(100));
	console.log(`SOL/USD: $${data.solUsdPrice?.toFixed(2) || "N/A"} | Last Updated: ${data.solUsdLastUpdated || "N/A"}`);
	console.log(`Temperature: ${data.marketTemperature.level} | ${data.marketTemperature.tokensPerMinute.toFixed(1)} tokens/min`);
	console.log(`Activity: 1min: ${data.marketTemperature.last1min} | 5min: ${data.marketTemperature.last5min} | 15min: ${data.marketTemperature.last15min}\n`);
	
	// Active Tracking
	console.log("📈 ACTIVE TRACKING SESSIONS");
	console.log("─".repeat(100));
	if (data.activeTracking && data.activeTracking.length > 0) {
		data.activeTracking.forEach((session, idx) => {
			const token = data.tokens?.find(t => t.address === session.tokenAddress);
			const tokenName = token ? `${token.name || token.symbol || "Unknown"}` : session.tokenAddress.substring(0, 8);
			const duration = Math.floor((new Date() - new Date(session.startedAt)) / 1000);
			
			console.log(`${idx + 1}. ${tokenName.padEnd(20)} | Strategy: ${session.strategyId.padEnd(25)} | Duration: ${duration}s`);
			console.log(`   Entry Price: ${session.entryPrice?.toFixed(8) || "pending"} SOL | MC: $${Math.round(session.entryMcUsd || 0)}`);
		});
	} else {
		console.log("   No active tracking sessions");
	}
	console.log();
	
	// Monitored Tokens
	console.log("👁️  MONITORED TOKENS (Top 20 by Activity)");
	console.log("─".repeat(100));
	if (data.tokens && data.tokens.length > 0) {
		const tokensWithStats = data.tokens
			.map(token => {
				const tradeStats = data.tradeStats?.[token.address];
				return {
					...token,
					...tradeStats,
				};
			})
			.filter(t => t.total > 0)
			.sort((a, b) => (b.total || 0) - (a.total || 0))
			.slice(0, 20);
		
		console.log("   Name                 | Trades | Buys | Sells | Unique | Buy% | Creator Sold | MC USD");
		console.log("   " + "─".repeat(96));
		
		tokensWithStats.forEach(token => {
			const name = (token.name || token.symbol || "Unknown").substring(0, 20).padEnd(20);
			const trades = (token.total || 0).toString().padStart(6);
			const buys = (token.buys || 0).toString().padStart(4);
			const sells = (token.sells || 0).toString().padStart(5);
			const unique = (token.uniqueTraders || 0).toString().padStart(6);
			const buyPct = ((token.buys || 0) / (token.total || 1) * 100).toFixed(0).padStart(3);
			const creatorSold = token.sellPercentage?.toFixed(0).padStart(3) || "  0";
			const mcUsd = token.exitMarketCapUsd ? Math.round(token.exitMarketCapUsd).toString().padStart(8) : "       -";
			
			console.log(`   ${name} | ${trades} | ${buys} | ${sells} | ${unique} | ${buyPct}% | ${creatorSold}%         | ${mcUsd}`);
		});
	} else {
		console.log("   No tokens being monitored yet");
	}
	console.log();
	
	// Strategies
	console.log("🎯 ACTIVE STRATEGIES");
	console.log("─".repeat(100));
	if (data.trackingFilters) {
		const strategies = Object.keys(data.trackingFilters);
		console.log(`   Loaded: ${strategies.length} strategies`);
		strategies.forEach(stratId => {
			const filters = data.trackingFilters[stratId];
			console.log(`   • ${stratId}: MC ${filters.minMcUsd}-${filters.maxMcUsd} USD, ${filters.minBuys} buys, ${filters.minUniqueTraders} unique`);
		});
	}
	console.log();
	
	// Summary Stats
	console.log("═".repeat(100));
	console.log(`📊 Total Tokens Detected: ${data.marketTemperature.totalTokens} | Active Tracking: ${data.activeTracking?.length || 0}`);
	console.log(`📈 Subscriptions: ${data.subscriptions?.totalActive || 0} active (${data.subscriptions?.tokenTrades || 0} token trades)`);
	console.log("═".repeat(100));
	console.log("⟳ 5s refresh │ Ctrl+C to exit │ Use 'npm run metrics' for simple view");
}

function fetchStatus() {
	return new Promise((resolve, reject) => {
		const req = http.get(STATUS_URL, (res) => {
			let data = "";
			
			res.on("data", (chunk) => {
				data += chunk;
			});
			
			res.on("end", () => {
				try {
					const parsed = JSON.parse(data);
					resolve(parsed);
				} catch (e) {
					reject(new Error("Failed to parse JSON"));
				}
			});
		});
		
		req.on("error", (e) => {
			reject(e);
		});
		
		req.setTimeout(3000, () => {
			req.destroy();
			reject(new Error("Request timeout"));
		});
	});
}

async function startMonitor() {
	console.log("🚀 Starting Detailed Metrics Monitor...");
	console.log(`📡 Connecting to ${STATUS_URL}...\n`);
	
	while (isRunning) {
		try {
			const data = await fetchStatus();
			displayDetailedDashboard(data);
		} catch (error) {
			console.clear();
			console.log("═".repeat(100));
			console.log("                       🎯 PUMPPORTAL MONITOR - DETAILED VIEW");
			console.log("═".repeat(100));
			console.log("\n❌ Error connecting to server");
			console.log(`   ${error.message}`);
			console.log("\n💡 Make sure the main app is running with: npm start");
			console.log("\n⟳ Retrying in 5 seconds...");
		}
		
		await new Promise((resolve) => setTimeout(resolve, REFRESH_INTERVAL));
	}
}

// Handle Ctrl+C gracefully
process.on("SIGINT", () => {
	console.log("\n\n👋 Detailed metrics monitor stopped.");
	isRunning = false;
	process.exit(0);
});

// Start the monitor
startMonitor();
