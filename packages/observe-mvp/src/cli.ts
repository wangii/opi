import { extractObserveRecordsFromFile } from "./session-extractor.ts";

const sessionPath = process.argv[2];
if (!sessionPath) {
	console.error("Usage: npm run extract -- <session.jsonl>");
	process.exitCode = 2;
} else {
	const records = await extractObserveRecordsFromFile(sessionPath);
	process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
}
