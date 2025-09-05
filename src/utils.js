// Utilidades adicionales para el analizador de PumpPortal

// No logger imports needed in this module

/**
 * Formatea un número como porcentaje con 2 decimales
 * @param {number} value - Valor a formatear
 * @returns {string} Porcentaje formateado
 */
export function formatPercentage(value) {
	return `${value.toFixed(2)}%`;
}

/**
 * Formatea un timestamp para display
 * @param {Date} date - Fecha a formatear
 * @returns {string} Timestamp formateado
 */
export function formatTimestamp(date) {
	return date.toLocaleString("es-ES", {
		timeZone: "Europe/Madrid",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

// formatCurrencyEs se exporta al final del archivo

/**
 * Valida una dirección de Solana
 * @param {string} address - Dirección a validar
 * @returns {boolean} True si es válida
 */
export function isValidSolanaAddress(address) {
	// Validación básica de direcciones de Solana (base58, 32-44 caracteres)
	return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

/**
 * Calcula estadísticas de ventas de un creador
 * @param {Object} creatorTracking - Datos de tracking del creador
 * @returns {Object} Estadísticas calculadas
 */
export function calculateCreatorStats(creatorTracking) {
	const { totalTokensCreated, tokensSold, sellHistory } = creatorTracking;

	const totalSoldPercentage = (tokensSold / totalTokensCreated) * 100;
	const totalSolReceived = sellHistory.reduce((sum, sell) => sum + (sell.solAmount || 0), 0);
	const averageSellPrice = sellHistory.length > 0 ? sellHistory.reduce((sum, sell) => sum + (sell.price || 0), 0) / sellHistory.length : 0;

	return {
		totalSoldPercentage: formatPercentage(totalSoldPercentage),
		totalSolReceived,
		averageSellPrice,
		sellCount: sellHistory.length,
		lastSellTime: sellHistory.length > 0 ? sellHistory[sellHistory.length - 1].timestamp : null,
	};
}

/**
 * Filtra tokens por criterios específicos
 * @param {Array} tokens - Array de tokens
 * @param {Object} filters - Filtros a aplicar
 * @returns {Array} Tokens filtrados
 */
export function filterTokens(tokens, filters = {}) {
	return tokens.filter((token) => {
		// Filtro por edad del token
		if (filters.maxAgeHours) {
			const tokenAge = (Date.now() - token.createdAt.getTime()) / (1000 * 60 * 60);
			if (tokenAge > filters.maxAgeHours) return false;
		}

		// Filtro por supply mínimo
		if (filters.minSupply && token.initialSupply < filters.minSupply) return false;

		// Filtro por creador específico
		if (filters.creator && token.creator !== filters.creator) return false;

		return true;
	});
}

/**
 * Genera un resumen de alertas activas
 * @param {Array} creators - Array de creadores con tracking
 * @param {number} threshold - Umbral de alerta
 * @returns {Array} Alertas activas
 */
export function generateActiveAlerts(creators, threshold) {
	return creators
		.map((creator) => {
			const totalSoldPercentage = (creator.tokensSold / creator.totalTokensCreated) * 100;
			if (totalSoldPercentage >= threshold) {
				return {
					creator: creator.creator,
					totalSoldPercentage: formatPercentage(totalSoldPercentage),
					tokensCount: creator.tokens.length,
					lastSellTime: creator.lastSellTime,
					stats: calculateCreatorStats(creator),
				};
			}
			return null;
		})
		.filter((alert) => alert !== null);
}

export function formatCurrencyEs(value, symbol = "$") {
	if (typeof value !== "number" || !isFinite(value)) return `0,00${symbol}`;
	const formatted = value.toLocaleString("es-ES", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
	return `${formatted}${symbol}`;
}
