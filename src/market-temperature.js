/**
 * market-temperature.js
 * Calcula la "temperatura del mercado" basándose en actividad de nuevos tokens
 */

class MarketTemperature {
	constructor() {
		this.newTokenTimestamps = []; // Array de timestamps de tokens nuevos
		this.windowMinutes = 15; // Ventana de 15 minutos para calcular temperatura
		this.totalTokensDetected = 0; // Total de tokens detectados desde el inicio
	}

	/**
	 * Registra un nuevo token detectado
	 */
	recordNewToken() {
		this.newTokenTimestamps.push(Date.now());
		this.totalTokensDetected++;
		this.cleanup();
	}

	/**
	 * Limpia timestamps viejos (fuera de la ventana)
	 */
	cleanup() {
		const cutoff = Date.now() - this.windowMinutes * 60 * 1000;
		this.newTokenTimestamps = this.newTokenTimestamps.filter((ts) => ts >= cutoff);
	}

	/**
	 * Calcula nuevos tokens por minuto
	 */
	getTokensPerMinute() {
		this.cleanup();
		if (this.newTokenTimestamps.length === 0) return 0;

		// Calcular en los últimos 5 minutos para mejor precisión
		const last5min = Date.now() - 5 * 60 * 1000;
		const recentTokens = this.newTokenTimestamps.filter((ts) => ts >= last5min);

		return recentTokens.length / 5; // tokens por minuto
	}

	/**
	 * Obtiene el nivel de temperatura del mercado
	 * @returns {string} - 'FREEZING', 'COLD', 'COOL', 'WARM', 'HOT', 'BURNING'
	 */
	getTemperatureLevel() {
		const tpm = this.getTokensPerMinute();

		if (tpm >= 10) return "BURNING"; // 🔥🔥🔥
		if (tpm >= 7) return "HOT"; // 🔥🔥
		if (tpm >= 5) return "WARM"; // 🔥
		if (tpm >= 3) return "COOL"; // ❄️
		if (tpm >= 1) return "COLD"; // ❄️❄️
		return "FREEZING"; // ❄️❄️❄️
	}

	/**
	 * Obtiene el emoji de temperatura
	 */
	getTemperatureEmoji() {
		const level = this.getTemperatureLevel();
		const emojis = {
			BURNING: "🔥🔥🔥",
			HOT: "🔥🔥",
			WARM: "🔥",
			COOL: "❄️",
			COLD: "❄️❄️",
			FREEZING: "❄️❄️❄️",
		};
		return emojis[level] || "❄️";
	}

	/**
	 * Obtiene el color de temperatura
	 */
	getTemperatureColor() {
		const level = this.getTemperatureLevel();
		const colors = {
			BURNING: "🟥", // Rojo
			HOT: "🟧", // Naranja
			WARM: "🟨", // Amarillo
			COOL: "🟦", // Azul claro
			COLD: "🟦", // Azul
			FREEZING: "⬜", // Blanco
		};
		return colors[level] || "⬜";
	}

	/**
	 * Obtiene estadísticas completas de temperatura
	 */
	getStats() {
		this.cleanup();
		const tpm = this.getTokensPerMinute();
		const level = this.getTemperatureLevel();
		const emoji = this.getTemperatureEmoji();
		const color = this.getTemperatureColor();

		// Calcular tokens en diferentes ventanas
		const now = Date.now();
		const last1min = this.newTokenTimestamps.filter((ts) => ts >= now - 60000).length;
		const last5min = this.newTokenTimestamps.filter((ts) => ts >= now - 5 * 60000).length;
		const last15min = this.newTokenTimestamps.length;

		return {
			tokensPerMinute: parseFloat(tpm.toFixed(2)),
			level,
			emoji,
			color,
			last1min,
			last5min,
			last15min,
			totalTracked: this.newTokenTimestamps.length,
			totalTokens: this.totalTokensDetected, // Total desde el inicio
		};
	}

	/**
	 * Obtiene una descripción de la temperatura
	 */
	getDescription() {
		const level = this.getTemperatureLevel();
		const descriptions = {
			BURNING: "🔥 Market is ON FIRE! Huge activity!",
			HOT: "🔥 Very active market, lots of new tokens",
			WARM: "🔥 Moderate activity, good time to trade",
			COOL: "❄️ Quiet market, few new tokens",
			COLD: "❄️ Very quiet, minimal activity",
			FREEZING: "❄️ Dead market, almost no activity",
		};
		return descriptions[level] || "Unknown";
	}

	/**
	 * Reset statistics
	 */
	reset() {
		this.newTokenTimestamps = [];
		this.totalTokensDetected = 0;
	}
}

export default MarketTemperature;
