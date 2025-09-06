import fs from "fs";
import path from "path";
import readline from "readline";

// Simple splitter for tracking-summaries.log into good/bad/neutral JSONL files
// Usage: node src/split-summaries-by-outcome.js [inputLogPath]

const inputPath = process.argv[2] || path.join("logs", "tracking-summaries.log");
const outDir = path.join("logs", "summary-outcomes");

/**
 * Ensure directory exists
 * @param {string} dir
 */
async function ensureDir(dir) {
	await fs.promises.mkdir(dir, { recursive: true });
}

/**
 * Extract JSON substring from a log line (first '{' to end)
 * @param {string} line
 * @returns {string|null}
 */
function extractJson(line) {
	const idx = line.indexOf("{");
	if (idx === -1) return null;
	return line.slice(idx);
}

/**
 * Create write streams for each outcome
 */
async function createWriters() {
	await ensureDir(outDir);
	const writers = {
		good: fs.createWriteStream(path.join(outDir, "good.jsonl"), { flags: "w" }),
		bad: fs.createWriteStream(path.join(outDir, "bad.jsonl"), { flags: "w" }),
		neutral: fs.createWriteStream(path.join(outDir, "neutral.jsonl"), { flags: "w" }),
	};
	return writers;
}

async function main() {
	// Validate input file exists
	try {
		await fs.promises.access(inputPath, fs.constants.R_OK);
	} catch {
		console.error(`No se puede leer el archivo: ${inputPath}`);
		process.exit(1);
	}

	const writers = await createWriters();
	const counts = { good: 0, bad: 0, neutral: 0, skipped: 0, errors: 0 };

	const rl = readline.createInterface({
		input: fs.createReadStream(inputPath, { encoding: "utf8" }),
		crlfDelay: Infinity,
	});

	for await (const line of rl) {
		if (!line || line.trim().length === 0) continue;

		const jsonStr = extractJson(line);
		if (!jsonStr) {
			counts.skipped++;
			continue;
		}

		let obj;
		try {
			obj = JSON.parse(jsonStr);
		} catch {
			counts.errors++;
			continue;
		}

		if (obj?.type !== "summary") {
			counts.skipped++;
			continue;
		}

		const outcome = obj?.outcome;
		if (outcome === "good" || outcome === "bad" || outcome === "neutral") {
			const serialized = JSON.stringify(obj);
			writers[outcome].write(serialized + "\n");
			counts[outcome]++;
		} else {
			counts.skipped++;
		}
	}

	await new Promise((resolve) => {
		writers.good.end(() => {
			writers.bad.end(() => {
				writers.neutral.end(resolve);
			});
		});
	});

	console.log("Resumen de división por outcome:");
	console.log(`  good:    ${counts.good}`);
	console.log(`  bad:     ${counts.bad}`);
	console.log(`  neutral: ${counts.neutral}`);
	console.log(`  skipped: ${counts.skipped}`);
	console.log(`  errors:  ${counts.errors}`);
	console.log(`Salida: ${outDir}/(good|bad|neutral).jsonl`);
}

main().catch((err) => {
	console.error("Error ejecutando el splitter:", err);
	process.exit(1);
});
