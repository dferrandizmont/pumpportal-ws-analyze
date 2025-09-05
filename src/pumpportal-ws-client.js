import WebSocket from "ws";
import logger from "./logger.js";
import config from "./config.js";

class PumpPortalWSClient {
	constructor() {
		this.ws = null;
		this.isConnected = false;
		this.reconnectAttempts = 0;
		this.subscribedTokens = new Set();
		this.subscribedAccounts = new Set();
		this.messageHandlers = new Map();
	}

	connect() {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			logger.pumpWs("Already connected to PumpPortal WebSocket");
			return;
		}

		try {
			const wsUrl = config.pumpPortal.apiKey ? `${config.pumpPortal.wsUrl}?api-key=${config.pumpPortal.apiKey}` : config.pumpPortal.wsUrl;

			logger.pumpWs(`Connecting to PumpPortal WebSocket: ${wsUrl}`);
			this.ws = new WebSocket(wsUrl);

			this.ws.on("open", () => {
				logger.pumpWs("Successfully connected to PumpPortal WebSocket");
				this.isConnected = true;
				this.reconnectAttempts = 0;

				// Re-subscribe to all previous subscriptions
				this.resubscribeAll();
			});

			this.ws.on("message", (data) => {
				try {
					const message = JSON.parse(data.toString());
					this.handleMessage(message);
				} catch (error) {
					logger.errorMonitor("Failed to parse WebSocket message", { error: error.message, data: data.toString() });
				}
			});

			this.ws.on("error", (error) => {
				logger.errorMonitor("WebSocket error occurred", { error: error.message });
				this.isConnected = false;
			});

			this.ws.on("close", (code, reason) => {
				logger.pumpWs(`WebSocket connection closed`, { code, reason: reason.toString() });
				this.isConnected = false;
				this.handleReconnection();
			});
		} catch (error) {
			logger.errorMonitor("Failed to create WebSocket connection", { error: error.message });
			this.handleReconnection();
		}
	}

	disconnect() {
		if (this.ws) {
			logger.pumpWs("Disconnecting from PumpPortal WebSocket");
			this.ws.close();
			this.ws = null;
			this.isConnected = false;
		}
	}

	handleReconnection() {
		if (this.reconnectAttempts >= config.app.maxReconnectAttempts) {
			logger.errorMonitor(`Maximum reconnection attempts (${config.app.maxReconnectAttempts}) reached. Stopping reconnection.`);
			return;
		}

		this.reconnectAttempts++;
		const delay = config.app.reconnectDelayMs * 1.5 ** (this.reconnectAttempts - 1); // Exponential backoff

		logger.pumpWs(`Attempting reconnection in ${delay}ms (attempt ${this.reconnectAttempts}/${config.app.maxReconnectAttempts})`);

		setTimeout(() => {
			this.connect();
		}, delay);
	}

	sendMessage(message) {
		if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
			logger.errorMonitor("Cannot send message: WebSocket not connected");
			return false;
		}

		try {
			this.ws.send(JSON.stringify(message));
			logger.pumpWs("Sent message to PumpPortal", { method: message.method, keys: message.keys });
			return true;
		} catch (error) {
			logger.errorMonitor("Failed to send message", { error: error.message, method: message.method });
			return false;
		}
	}

	subscribeNewTokens() {
		const message = { method: "subscribeNewToken" };
		if (this.sendMessage(message)) {
			logger.pumpWs("Subscribed to new token events");
		}
	}

	unsubscribeNewTokens() {
		const message = { method: "unsubscribeNewToken" };
		if (this.sendMessage(message)) {
			logger.pumpWs("Unsubscribed from new token events");
		}
	}

	subscribeTokenTrades(tokenAddresses) {
		const message = {
			method: "subscribeTokenTrade",
			keys: Array.isArray(tokenAddresses) ? tokenAddresses : [tokenAddresses],
		};

		if (this.sendMessage(message)) {
			message.keys.forEach((address) => this.subscribedTokens.add(address));
			logger.pumpWs("Subscribed to token trades", { tokens: message.keys });
		}
	}

	unsubscribeTokenTrades(tokenAddresses) {
		const message = {
			method: "unsubscribeTokenTrade",
			keys: Array.isArray(tokenAddresses) ? tokenAddresses : [tokenAddresses],
		};

		if (this.sendMessage(message)) {
			message.keys.forEach((address) => this.subscribedTokens.delete(address));
			logger.pumpWs("Unsubscribed from token trades", { tokens: message.keys });
		}
	}

	subscribeAccountTrades(accountAddresses) {
		const message = {
			method: "subscribeAccountTrade",
			keys: Array.isArray(accountAddresses) ? accountAddresses : [accountAddresses],
		};

		if (this.sendMessage(message)) {
			message.keys.forEach((address) => this.subscribedAccounts.add(address));
			logger.pumpWs("Subscribed to account trades", { accounts: message.keys });
		}
	}

	unsubscribeAccountTrades(accountAddresses) {
		const message = {
			method: "unsubscribeAccountTrade",
			keys: Array.isArray(accountAddresses) ? accountAddresses : [accountAddresses],
		};

		if (this.sendMessage(message)) {
			message.keys.forEach((address) => this.subscribedAccounts.delete(address));
			logger.pumpWs("Unsubscribed from account trades", { accounts: message.keys });
		}
	}

	resubscribeAll() {
		// Re-subscribe to new tokens
		this.subscribeNewTokens();

		// Re-subscribe to token trades
		if (this.subscribedTokens.size > 0) {
			this.subscribeTokenTrades(Array.from(this.subscribedTokens));
		}

		// Re-subscribe to account trades
		if (this.subscribedAccounts.size > 0) {
			this.subscribeAccountTrades(Array.from(this.subscribedAccounts));
		}
	}

	onMessage(type, handler) {
		this.messageHandlers.set(type, handler);
	}

	handleMessage(message) {
		// Handle different message types and formats
		let messageType = message.type;

		// Handle messages without type field
		if (!messageType) {
			// Handle subscription confirmations
			if (message.message) {
				messageType = "subscription_confirmation";
				logger.debugPumpWs("Subscription confirmation received", { message: message.message });
				return; // Don't process subscription confirmations further
			}

			// Handle direct token/trade messages (PumpPortal format)
			if (message.txType === "create") {
				messageType = "newToken";
			} else if (message.txType === "buy" || message.txType === "sell") {
				messageType = "trade";
			} else {
				if (message.signature) {
					// This might be a trade or token creation without explicit txType
					logger.debugPumpWs("Received message with signature but no txType", {
						messageKeys: Object.keys(message),
						signature: message.signature,
					});
				} else {
					logger.debugPumpWs("Received unhandled message", {
						messageKeys: Object.keys(message),
					});
				}
				return;
			}
		}

		// Reduce noisy trade processing logs if configured
		if (!(messageType === "trade" && config.logging.trade && config.logging.trade.suppressPumpWsTradeProcessingLog)) {
			logger.debugPumpWs("Processing message", { type: messageType, hasData: !!message });
		}

		const handler = this.messageHandlers.get(messageType);
		if (handler) {
			try {
				handler(message);
			} catch (error) {
				logger.errorMonitor("Error in message handler", { error: error.message, type: messageType });
			}
		} else {
			logger.debugPumpWs("No handler registered for message type", { type: messageType, availableHandlers: Array.from(this.messageHandlers.keys()) });
		}
	}
}

export default PumpPortalWSClient;
