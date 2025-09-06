import fs from "fs";
import readline from "readline";

export async function readJsonl(filePath, { filter } = {}) {
	const results = [];
	const rl = readline.createInterface({
		input: fs.createReadStream(filePath, { encoding: "utf8" }),
		crlfDelay: Infinity,
	});

	for await (const line of rl) {
		if (!line || line.trim().length === 0) continue;
		try {
			const obj = JSON.parse(line);
			if (!filter || filter(obj)) results.push(obj);
		} catch {
			// ignore parse errors in JSONL context
		}
	}

	return results;
}

export function ensureDirSync(dir) {
	fs.mkdirSync(dir, { recursive: true });
}

export function writeCsv(filePath, rows, headers) {
	const escape = (v) => {
		if (v === null || v === undefined) return "";
		const s = String(v);
		if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
		return s;
	};
	const csv = [];
	if (headers && headers.length) csv.push(headers.map(escape).join(","));
	for (const row of rows) {
		const values = headers ? headers.map((h) => row[h]) : Object.values(row);
		csv.push(values.map(escape).join(","));
	}
	fs.writeFileSync(filePath, csv.join("\n"), "utf8");
}
