import WebSocket from "ws";
import fs from "fs";
import path from "path";

/**
 * PumpPortal WebSocket Test
 *
 * Test enfocado en 3 métodos principales:
 * 1. subscribeNewToken - Detecta nuevos tokens
 * 2. subscribeTokenTrade - Se suscribe automáticamente a trades del token nuevo
 * 3. subscribeAccountTrade - Se suscribe automáticamente a trades del creador
 */

class PumpPortalTest {
	constructor() {
		this.ws = null;
		this.timeout = 30000; // 30 segundos para generar archivos más rápido
		this.outputDir = "./pumpportal-test-results";

		// Datos capturados
		this.newTokens = [];
		this.tokenTrades = [];
		this.accountTrades = [];

		// Control de suscripciones
		this.subscribedTokens = new Set();
		this.subscribedAccounts = new Set();
		this.maxSubscriptions = 10; // Límite para evitar spam

		// Crear directorio de salida
		if (!fs.existsSync(this.outputDir)) {
			fs.mkdirSync(this.outputDir, { recursive: true });
		}
	}

	async start() {
		console.log("🔬 PumpPortal WebSocket Test");
		console.log("=============================");
		console.log(`⏱️  Timeout: ${this.timeout / 1000}s`);
		console.log(`📁 Salida: ${this.outputDir}`);
		console.log("🎯 Métodos: subscribeNewToken, subscribeTokenTrade, subscribeAccountTrade\n");

		return new Promise((resolve, reject) => {
			// Timeout de seguridad
			const timeoutId = setTimeout(() => {
				console.log("\n⏰ Timeout alcanzado, finalizando...");
				this.stop();
				this.saveResults();
				resolve();
			}, this.timeout);

			// Manejar Ctrl+C para guardar resultados
			const handleExit = () => {
				console.log("\n⚠️ Señal de interrupción recibida, guardando resultados...");
				clearTimeout(timeoutId);
				this.stop();
				this.saveResults();
				resolve();
			};

			process.on("SIGINT", handleExit);
			process.on("SIGTERM", handleExit);

			// Conectar WebSocket
			this.ws = new WebSocket("wss://pumpportal.fun/api/data");

			this.ws.on("open", () => {
				console.log("✅ Conexión WebSocket establecida");

				// Suscribirse a nuevos tokens (punto de entrada principal)
				this.subscribeToNewTokens();

				console.log("🔄 Esperando nuevos tokens para auto-suscripción...\n");
			});

			this.ws.on("message", (data) => {
				this.handleMessage(data);
			});

			this.ws.on("error", (error) => {
				console.error("❌ Error WebSocket:", error);
				clearTimeout(timeoutId);
				reject(error);
			});

			this.ws.on("close", () => {
				console.log("🔌 Conexión cerrada");
				clearTimeout(timeoutId);
				this.saveResults();
				resolve();
			});
		});
	}

	subscribeToNewTokens() {
		const payload = { method: "subscribeNewToken" };
		this.ws.send(JSON.stringify(payload));
		console.log("📝 Suscrito a: subscribeNewToken");
	}

	subscribeToTokenTrade(mint, symbol) {
		if (this.subscribedTokens.has(mint) || this.subscribedTokens.size >= this.maxSubscriptions) {
			return;
		}

		const payload = {
			method: "subscribeTokenTrade",
			keys: [mint],
		};

		this.ws.send(JSON.stringify(payload));
		this.subscribedTokens.add(mint);
		console.log(`📝 Suscrito a: subscribeTokenTrade (${symbol || mint.slice(0, 8)}...)`);
	}

	subscribeToAccountTrade(account, label) {
		if (this.subscribedAccounts.has(account) || this.subscribedAccounts.size >= this.maxSubscriptions) {
			return;
		}

		const payload = {
			method: "subscribeAccountTrade",
			keys: [account],
		};

		this.ws.send(JSON.stringify(payload));
		this.subscribedAccounts.add(account);
		console.log(`📝 Suscrito a: subscribeAccountTrade (${label || account.slice(0, 8)}...)`);
	}

	handleMessage(data) {
		try {
			const message = JSON.parse(data);

			// Mensajes del sistema
			if (message.message) {
				console.log(`📋 Sistema: ${message.message}`);
				return;
			}

			// 1. NUEVO TOKEN DETECTADO
			if (message.txType === "create") {
				this.handleNewToken(message);
			}

			// 2. TRADE DE TOKEN
			else if (message.txType === "buy" || message.txType === "sell") {
				this.handleTokenTrade(message);

				// TAMBIÉN verificar si es un trade de una cuenta suscrita
				if (this.subscribedAccounts.has(message.traderPublicKey)) {
					this.handleAccountTrade(message);
				}
			}

			// 3. OTROS TIPOS DE TRADES DE CUENTA
			else if (message.signature && message.traderPublicKey && this.subscribedAccounts.has(message.traderPublicKey)) {
				this.handleAccountTrade(message);
			}
		} catch (error) {
			console.error("❌ Error parseando mensaje:", error);
		}
	}

	handleNewToken(tokenData) {
		// Guardar nuevo token
		this.newTokens.push({
			timestamp: new Date().toISOString(),
			method: "subscribeNewToken",
			data: tokenData,
		});

		console.log(`\n🆕 NUEVO TOKEN: ${tokenData.symbol} (${tokenData.name})`);
		console.log(`   Mint: ${tokenData.mint}`);
		console.log(`   Creador: ${tokenData.traderPublicKey}`);
		console.log(`   Initial Buy: ${tokenData.solAmount} SOL`);

		// AUTO-SUSCRIPCIÓN a trades del token
		this.subscribeToTokenTrade(tokenData.mint, tokenData.symbol);

		// AUTO-SUSCRIPCIÓN a trades del creador
		this.subscribeToAccountTrade(tokenData.traderPublicKey, `Creator-${tokenData.symbol}`);
	}

	handleTokenTrade(tradeData) {
		// Guardar trade de token
		this.tokenTrades.push({
			timestamp: new Date().toISOString(),
			method: "subscribeTokenTrade",
			data: tradeData,
		});

		const action = tradeData.txType === "buy" ? "🟢 BUY " : "🔴 SELL";
		const volume = (tradeData.solAmount || 0).toFixed(4);
		const symbol = tradeData.symbol || tradeData.mint?.slice(0, 8);

		console.log(`${action} | ${symbol} | ${volume} SOL | MC: $${(tradeData.marketCapSol || 0).toFixed(2)}`);
	}

	handleAccountTrade(tradeData) {
		// Guardar trade de cuenta
		this.accountTrades.push({
			timestamp: new Date().toISOString(),
			method: "subscribeAccountTrade",
			data: tradeData,
		});

		const account = tradeData.traderPublicKey?.slice(0, 8) || "Unknown";
		const action = tradeData.txType?.toUpperCase() || "TRADE";
		const symbol = tradeData.symbol || "Unknown";

		console.log(`👤 ACCOUNT TRADE DETECTED | ${account}... | ${action} | ${symbol}`);
	}

	stop() {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.close();
		}
	}

	saveResults() {
		console.log("\n💾 Guardando resultados...\n");

		// 1. Guardar nuevos tokens
		if (this.newTokens.length > 0) {
			const file1 = path.join(this.outputDir, "subscribeNewToken.json");
			fs.writeFileSync(
				file1,
				JSON.stringify(
					{
						method: "subscribeNewToken",
						total: this.newTokens.length,
						collectedAt: new Date().toISOString(),
						responses: this.newTokens,
					},
					null,
					2
				)
			);
			console.log(`✅ subscribeNewToken.json (${this.newTokens.length} mensajes)`);
		}

		// 2. Guardar trades de tokens
		if (this.tokenTrades.length > 0) {
			const file2 = path.join(this.outputDir, "subscribeTokenTrade.json");
			fs.writeFileSync(
				file2,
				JSON.stringify(
					{
						method: "subscribeTokenTrade",
						total: this.tokenTrades.length,
						collectedAt: new Date().toISOString(),
						responses: this.tokenTrades,
					},
					null,
					2
				)
			);
			console.log(`✅ subscribeTokenTrade.json (${this.tokenTrades.length} mensajes)`);
		}

		// 3. Guardar trades de cuentas
		if (this.accountTrades.length > 0) {
			const file3 = path.join(this.outputDir, "subscribeAccountTrade.json");
			fs.writeFileSync(
				file3,
				JSON.stringify(
					{
						method: "subscribeAccountTrade",
						total: this.accountTrades.length,
						collectedAt: new Date().toISOString(),
						responses: this.accountTrades,
					},
					null,
					2
				)
			);
			console.log(`✅ subscribeAccountTrade.json (${this.accountTrades.length} mensajes)`);
		}

		// 4. Resumen
		const summary = {
			testCompletedAt: new Date().toISOString(),
			timeout: this.timeout,
			totalNewTokens: this.newTokens.length,
			totalTokenTrades: this.tokenTrades.length,
			totalAccountTrades: this.accountTrades.length,
			tokensSubscribed: this.subscribedTokens.size,
			accountsSubscribed: this.subscribedAccounts.size,
		};

		const summaryFile = path.join(this.outputDir, "test-summary.json");
		fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
		console.log(`✅ test-summary.json`);

		console.log("\n📊 RESUMEN FINAL:");
		console.log(`   🆕 Nuevos tokens: ${this.newTokens.length}`);
		console.log(`   📈 Token trades: ${this.tokenTrades.length}`);
		console.log(`   👤 Account trades: ${this.accountTrades.length}`);
		console.log(`   📝 Suscripciones token: ${this.subscribedTokens.size}`);
		console.log(`   👥 Suscripciones cuenta: ${this.subscribedAccounts.size}`);
		console.log(`\n📁 Archivos guardados en: ${this.outputDir}`);
	}
}

// Ejecutar el test
console.log("🚀 Iniciando PumpPortal WebSocket Test...\n");

const test = new PumpPortalTest();
test.start()
	.then(() => {
		console.log("\n🎉 Test completado exitosamente!");
		process.exit(0);
	})
	.catch((error) => {
		console.error("\n❌ Error durante el test:", error);
		process.exit(1);
	});

export default PumpPortalTest;
