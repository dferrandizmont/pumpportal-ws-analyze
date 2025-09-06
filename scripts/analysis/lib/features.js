export function toNumber(x) {
	const n = Number(x);
	return Number.isFinite(n) ? n : NaN;
}

export function computeFeatures(obj) {
	const preBuys = toNumber(obj.preBuys);
	const preSells = toNumber(obj.preSells);
	const preTotalTrades = toNumber(obj.preTotalTrades);
	const preUniqueTraders = toNumber(obj.preUniqueTraders);
	const entryMarketCapUsd = toNumber(obj.entryMarketCapUsd);
	const entryMarketCapSol = toNumber(obj.entryMarketCapSol);
	const ageAtTriggerSec = toNumber(obj.ageAtTriggerSec);
	const preEntryTotalTrades = toNumber(obj.preEntryTotalTrades);
	const preEntryBuys = toNumber(obj.preEntryBuys);
	const preEntrySells = toNumber(obj.preEntrySells);
	const preEntryUniqueTraders = toNumber(obj.preEntryUniqueTraders);
	const preEntryMinMcUsd = toNumber(obj.preEntryMinMcUsd);
	const preEntryMaxMcUsd = toNumber(obj.preEntryMaxMcUsd);

	const denom = preBuys + preSells;
	const buyRatio = denom > 0 ? preBuys / denom : NaN;
	const netBuys = preBuys - preSells;
	const uniquePerTrade = preTotalTrades > 0 ? preUniqueTraders / preTotalTrades : NaN;
	const buysPerUnique = preUniqueTraders > 0 ? preBuys / preUniqueTraders : NaN;
	const tradesPerUnique = preUniqueTraders > 0 ? preTotalTrades / preUniqueTraders : NaN;
	const mcPerUnique = preUniqueTraders > 0 && Number.isFinite(entryMarketCapUsd) ? entryMarketCapUsd / preUniqueTraders : NaN;

	// Deltas vs preEntry
	const deltaBuys = Number.isFinite(preEntryBuys) ? preBuys - preEntryBuys : NaN;
	const deltaSells = Number.isFinite(preEntrySells) ? preSells - preEntrySells : NaN;
	const deltaTrades = Number.isFinite(preEntryTotalTrades) ? preTotalTrades - preEntryTotalTrades : NaN;
	const deltaUnique = Number.isFinite(preEntryUniqueTraders) ? preUniqueTraders - preEntryUniqueTraders : NaN;

	const accelBuys = Number.isFinite(preEntryBuys) && preEntryBuys > 0 ? preBuys / preEntryBuys : NaN;
	const accelTrades = Number.isFinite(preEntryTotalTrades) && preEntryTotalTrades > 0 ? preTotalTrades / preEntryTotalTrades : NaN;
	const accelUnique = Number.isFinite(preEntryUniqueTraders) && preEntryUniqueTraders > 0 ? preUniqueTraders / preEntryUniqueTraders : NaN;

	// Volatilidad previa de market cap
	const volatilityAbs = Number.isFinite(preEntryMaxMcUsd) && Number.isFinite(preEntryMinMcUsd) ? preEntryMaxMcUsd - preEntryMinMcUsd : NaN;
	const volatilityRatio = Number.isFinite(preEntryMaxMcUsd) && Number.isFinite(preEntryMinMcUsd) && preEntryMinMcUsd > 0 ? preEntryMaxMcUsd / preEntryMinMcUsd : NaN;
	const imbalancePerTrade = preTotalTrades > 0 ? netBuys / preTotalTrades : NaN;

	return {
		tokenAddress: obj.tokenAddress,
		tokenName: obj.tokenName,
		tokenSymbol: obj.tokenSymbol,
		outcome: obj.outcome,
		preBuys,
		preSells,
		preTotalTrades,
		preUniqueTraders,
		buyRatio,
		netBuys,
		uniquePerTrade,
		buysPerUnique,
		tradesPerUnique,
		mcPerUnique,
		entryMarketCapUsd,
		entryMarketCapSol,
		ageAtTriggerSec,
		preEntryTotalTrades,
		preEntryBuys,
		preEntrySells,
		preEntryUniqueTraders,
		preEntryMinMcUsd,
		preEntryMaxMcUsd,
		deltaBuys,
		deltaSells,
		deltaTrades,
		deltaUnique,
		accelBuys,
		accelTrades,
		accelUnique,
		volatilityAbs,
		volatilityRatio,
		imbalancePerTrade,
	};
}

export function passesRule(feat, rule) {
	const {
		minBuys = 0,
		minTotalTrades = 0,
		minUniqueTraders = 0,
		minBuyRatio = 0,
		minNetBuys = 0,
		minMcUsd = -Infinity,
		maxMcUsd = Infinity,
		minUniquePerTrade = 0,
		minBuysPerUnique = 0,
		minDeltaBuys = -Infinity,
		maxVolatilityRatio = Infinity,
		maxAgeAtTriggerSec = Infinity,
	} = rule;

	if (!(Number.isFinite(feat.preBuys) && feat.preBuys >= minBuys)) return false;
	if (!(Number.isFinite(feat.preTotalTrades) && feat.preTotalTrades >= minTotalTrades)) return false;
	if (!(Number.isFinite(feat.preUniqueTraders) && feat.preUniqueTraders >= minUniqueTraders)) return false;
	if (!(Number.isFinite(feat.buyRatio) && feat.buyRatio >= minBuyRatio)) return false;
	if (!(Number.isFinite(feat.netBuys) && feat.netBuys >= minNetBuys)) return false;
	if (!(Number.isFinite(feat.entryMarketCapUsd) && feat.entryMarketCapUsd >= minMcUsd && feat.entryMarketCapUsd <= maxMcUsd)) return false;
	if (!(Number.isFinite(feat.uniquePerTrade) && feat.uniquePerTrade >= minUniquePerTrade)) return false;
	if (!(Number.isFinite(feat.buysPerUnique) && feat.buysPerUnique >= minBuysPerUnique)) return false;
	if (!(Number.isFinite(feat.deltaBuys) ? feat.deltaBuys >= minDeltaBuys : true)) return false;
	if (!(Number.isFinite(feat.volatilityRatio) ? feat.volatilityRatio <= maxVolatilityRatio : true)) return false;
	if (!(Number.isFinite(feat.ageAtTriggerSec) ? feat.ageAtTriggerSec <= maxAgeAtTriggerSec : true)) return false;
	return true;
}
