import http from "http";
import config from "../src/config.js";

const STATUS_URL = `http://localhost:${config.http.port}/status`;
const REFRESH_INTERVAL = 5000; // 5 seconds

let isRunning = true;

function formatDuration(seconds) {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	return `${h}h ${m}m`;
}

function getTemperatureDisplay(stats) {
	const { level, tokensPerMinute } = stats;
	
	const icons = {
		FREEZING: "❄️❄️❄️ FREEZING",
		COLD: "❄️❄️ COLD    ",
		COOL: "❄️ COOL     ",
		WARM: "🌡️  WARM     ",
		HOT: "🔥🔥 HOT     ",
		BURNING: "🔥🔥🔥 BURNING ",
	};
	
	const bars = {
		FREEZING: "░░░░░░░░░░░░░░░░░░░░",
		COLD: "░░░░░░░░░░░░░░░░░░░░",
		COOL: "▓▓▓▓▓░░░░░░░░░░░░░░░",
		WARM: "▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░",
		HOT: "▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░",
		BURNING: "▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓",
	};
	
	return {
		icon: icons[level] || "? UNKNOWN",
		bar: bars[level] || "░░░░░░░░░░░░░░░░░░░░",
		rate: tokensPerMinute.toFixed(1),
	};
}

function displayDashboard(data) {
	console.clear();
	
	const uptime = formatDuration(Math.floor(data.uptime));
	const now = new Date().toLocaleTimeString();
	const marketTemp = getTemperatureDisplay(data.marketTemperature);
	
	// Header
	console.log("═".repeat(80));
	console.log("                🎯 PUMPPORTAL MONITOR - Fast Trade Signals");
	console.log("═".repeat(80));
	console.log(`⏰ ${now} | 🟢 CONNECTED | Uptime: ${uptime}\n`);
	
	// Market Temperature
	console.log("🌡️  MARKET TEMPERATURE");
	console.log("─".repeat(80));
	console.log(`${marketTemp.icon} │ ${marketTemp.bar} │ ${marketTemp.rate} tokens/min`);
	console.log(`📊 Activity: Last 1min: ${data.marketTemperature.last1min.toString().padStart(2)} | 5min: ${data.marketTemperature.last5min.toString().padStart(2)} | 15min: ${data.marketTemperature.last15min.toString().padStart(3)}\n`);
	
	// Activity Summary
	const totalDetected = data.marketTemperature.totalTokens || 0;
	const tracking = data.activeTracking || [];
	const activeStrategies = new Set(tracking.map(t => t.strategyId)).size;
	
	// Count quality tokens
	let qualityCount = { excellent: 0, good: 0, decent: 0 };
	if (data.tokens && Array.isArray(data.tokens)) {
		data.tokens.forEach(token => {
			const tradeStats = data.tradeStats?.[token.address];
			if (!tradeStats) return;
			
			const { buys = 0, total = 0, uniqueTraders = 0 } = tradeStats;
			const buyRatio = total > 0 ? buys / total : 0;
			
			// Simple quality scoring
			if (buyRatio >= 0.7 && uniqueTraders >= 10) qualityCount.excellent++;
			else if (buyRatio >= 0.6 && uniqueTraders >= 7) qualityCount.good++;
			else if (buyRatio >= 0.5 && uniqueTraders >= 5) qualityCount.decent++;
		});
	}
	
	console.log("📊 ACTIVITY SUMMARY");
	console.log("─".repeat(80));
	console.log(`🆕 Detected: ${totalDetected.toString().padStart(4)} │ 📈 Tracking: ${tracking.length.toString().padStart(2)} (${activeStrategies} strategies) │ 🏆 Quality: 🟢 ${qualityCount.excellent} 🟡 ${qualityCount.good} 🟠 ${qualityCount.decent}\n`);
	
	// Top Opportunities (limit to 5)
	console.log("🏆 TOP OPPORTUNITIES (Highest Scores)");
	console.log("─".repeat(80));
	console.log();
	
	if (data.tokens && Array.isArray(data.tokens) && data.tokens.length > 0) {
		// Score and sort tokens
		const scoredTokens = data.tokens
			.map(token => {
				const tradeStats = data.tradeStats?.[token.address];
				if (!tradeStats) return null;
				
				const { buys = 0, sells = 0, total = 0, uniqueTraders = 0 } = tradeStats;
				const buyRatio = total > 0 ? buys / total : 0;
				const netBuys = buys - sells;
				
				// Simple score calculation (0-100)
				let score = 0;
				score += buyRatio * 40; // Buy ratio worth 40 points
				score += Math.min(uniqueTraders / 20, 1) * 30; // Unique traders worth 30 points
				score += Math.min(netBuys / 10, 1) * 20; // Net buys worth 20 points
				score += Math.min(total / 20, 1) * 10; // Total trades worth 10 points
				
				return {
					...token,
					tradeStats,
					score: Math.round(score),
					buyRatio,
					netBuys,
				};
			})
			.filter(t => t !== null && t.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, 5);
		
		if (scoredTokens.length > 0) {
			scoredTokens.forEach(token => {
				const { name, symbol, address, sellPercentage, tradeStats, score, buyRatio } = token;
				const displayName = (name || symbol || "Unknown").substring(0, 15).padEnd(15);
				const shortAddr = address.substring(0, 8) + "...";
				
				// Quality indicator
				let indicator = "🟠 OK   ";
				if (score >= 80) indicator = "🟢 ⭐ OPTIMAL";
				else if (score >= 60) indicator = "🟡 👀 GOOD   ";
				
				console.log(`${indicator} │ ${displayName} │ Score: ${score.toString().padStart(3)}/100`);
				console.log(`   Creator Sold: ${sellPercentage.toFixed(0).toString().padStart(3)}% │ ${shortAddr}`);
				console.log(`   📊 Trades: ${tradeStats.total.toString().padStart(2)} │ 👥 Unique: ${tradeStats.uniqueTraders.toString().padStart(2)} │ 📈 Buy Ratio: ${(buyRatio * 100).toFixed(0)}%`);
				console.log();
			});
		} else {
			console.log("   ⏳ Waiting for quality tokens...\n");
		}
	} else {
		console.log("   ⏳ No tokens detected yet...\n");
	}
	
	// Footer
	console.log("═".repeat(80));
	console.log(`📊 Quality: 🟢 ${qualityCount.excellent} │ 🟡 ${qualityCount.good} │ 🟠 ${qualityCount.decent} │ Total Tokens: ${totalDetected}`);
	console.log("═".repeat(80));
	console.log("⟳ 5s refresh │ Ctrl+C to exit");
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
	console.log("🚀 Starting Metrics Monitor...");
	console.log(`📡 Connecting to ${STATUS_URL}...\n`);
	
	while (isRunning) {
		try {
			const data = await fetchStatus();
			displayDashboard(data);
		} catch (error) {
			console.clear();
			console.log("═".repeat(80));
			console.log("                🎯 PUMPPORTAL MONITOR - Fast Trade Signals");
			console.log("═".repeat(80));
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
	console.log("\n\n👋 Metrics monitor stopped.");
	isRunning = false;
	process.exit(0);
});

// Start the monitor
startMonitor();
