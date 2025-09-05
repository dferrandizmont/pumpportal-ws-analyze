import winston from "winston";
import moment from "moment-timezone";
import config from "./config.js";

// Custom timestamp format for Madrid timezone
const madridTimestamp = winston.format((info) => {
	const madridTime = moment().tz(config.logging.timezone);
	info.timestamp = madridTime.format("DD-MM-YYYY HH:mm:ss.SSS");
	return info;
});

// Custom format for consistent logging
const customFormat = winston.format.combine(
	madridTimestamp(),
	winston.format.errors({ stack: true }),
	winston.format.printf(({ timestamp, level, message, ...meta }) => {
		let logMessage = `${timestamp} ${level.toUpperCase()} ${message}`;

		// Add metadata if present
		if (Object.keys(meta).length > 0) {
			logMessage += ` ${JSON.stringify(meta)}`;
		}

		return logMessage;
	})
);

// Create logger instance
const logger = winston.createLogger({
	level: config.logging.level,
	format: customFormat,
	transports: [
		// Console transport for development
		new winston.transports.Console({
			format: winston.format.combine(winston.format.colorize(), customFormat),
		}),

		// File transport for persistent logging
		new winston.transports.File({
			filename: "logs/pumpportal-monitor.log",
			format: customFormat,
		}),

		// Error log file
		new winston.transports.File({
			filename: "logs/pumpportal-monitor-error.log",
			level: "error",
			format: customFormat,
		}),
	],
});

// Add prefix methods for different components
logger.pumpWs = (message, meta) => logger.info(`[PUMP_WS] ${message}`, meta);
logger.tokenMonitor = (message, meta) => logger.info(`[TOKEN_MONITOR] ${message}`, meta);
logger.creatorSell = (message, meta) => logger.warn(`[CREATOR_SELL] ${message}`, meta);
logger.warnMonitor = (message, meta) => logger.warn(`[WARN] ${message}`, meta);
logger.errorMonitor = (message, meta) => logger.error(`[ERROR] ${message}`, meta);

// Debug level methods (less noisy)
logger.debugPumpWs = (message, meta) => logger.debug(`[PUMP_WS] ${message}`, meta);
logger.debugTokenMonitor = (message, meta) => logger.debug(`[TOKEN_MONITOR] ${message}`, meta);
logger.debugCreatorSell = (message, meta) => logger.debug(`[CREATOR_SELL] ${message}`, meta);

// Alert logger for important creator sell events
const alertLogger = winston.createLogger({
	level: "info",
	format: customFormat,
	transports: [
		new winston.transports.File({
			filename: "logs/creator-sell-alerts.log",
			format: customFormat,
		}),
		// Also log alerts to console for immediate visibility
		new winston.transports.Console({
			format: winston.format.combine(winston.format.colorize(), customFormat),
			level: "info",
		}),
	],
});

// Alert method for threshold breaches
logger.creatorAlert = (message, meta) => {
	// Log to main logger
	logger.creatorSell(message, meta);
	// Log to dedicated alerts file
	alertLogger.info(`ALERT: ${message}`, meta);
};

export default logger;
