import config from "./config.js";
import logger from "./logger.js";

class PriceService {
	constructor() {
		this.solUsd = null; // number
		this.lastUpdated = null; // Date
		this.timer = null; // Interval handle
	}

	start() {
		if (this.timer) return;

		// Initial fetch
		this.updatePrice();

		// Schedule periodic updates
		const interval = config.prices.refreshIntervalMs;
		this.timer = setInterval(() => this.updatePrice(), interval);
		logger.tokenMonitor(`PriceService started. Refresh every ${Math.round(interval / 1000)}s`);
	}

	stop() {
		if (!this.timer) return;

		clearInterval(this.timer);
		this.timer = null;
		logger.tokenMonitor("PriceService stopped");
	}

	async updatePrice() {
		const url = config.prices.coingeckoSolEndpoint;

		try {
			const response = await fetch(url);

			if (!response.ok) {
				logger.errorMonitor("[PRICE_SERVICE] HTTP error fetching CoinGecko price", {
					status: response.status,
					statusText: response.statusText,
				});
				return;
			}

			const json = await response.json();
			const usd = json?.market_data?.current_price?.usd;

			if (typeof usd === "number" && usd > 0) {
				this.solUsd = usd;
				this.lastUpdated = new Date();
				logger.debugTokenMonitor("[PRICE_SERVICE] SOL/USD price updated", { solUsd: usd });
			} else {
				logger.warnMonitor("[PRICE_SERVICE] Unexpected response structure from CoinGecko", {
					preview: JSON.stringify(json).slice(0, 200),
				});
			}
		} catch (error) {
			logger.errorMonitor("[PRICE_SERVICE] Error fetching CoinGecko price", {
				error: error.message,
				url,
			});
		}
	}

	getSolUsd() {
		return this.solUsd;
	}

	getLastUpdated() {
		return this.lastUpdated;
	}
}

const priceService = new PriceService();
export default priceService;
