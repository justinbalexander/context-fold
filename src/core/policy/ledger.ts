/*
 * ledger.ts — deterministic FACT LEDGER + RISK FLAGS. Pure, zero-latency regex harvest over a
 * block's text. Two jobs:
 *   1. riskFlags(text) — which high-value categories a block contains (makes risk-bearing blocks
 *      STICKIER: they sort later in the fold-candidate list).
 *   2. harvestFacts(blocks) — a deduped, capped, category-ordered ledger of exact load-bearing
 *      tokens across all blocks, surfaced to the human so the *names* survive compression.
 *
 * No Date, no Math.random, no global state — same input ⇒ byte-identical output. Ported from
 * Accordion `conductors/keel/ledger.ts` (pinned commit 0c22434).
 */
import type { ViewBlock, ConductorFactLedgerEntry } from "../contract";

export type FactCategory = "exact_values" | "decisions" | "commands" | "errors" | "paths";

const CATEGORY_ORDER: readonly FactCategory[] = ["exact_values", "decisions", "commands", "errors", "paths"];
const RISK_CATEGORIES: readonly FactCategory[] = ["exact_values", "decisions", "commands", "paths"];

const VALUE_STOPWORDS = new Set([
	"the", "and", "for", "this", "that", "with", "from", "true", "false", "null",
	"const", "let", "var", "type", "return", "import", "export", "function",
]);

const PER_BLOCK_CAP = 3;

interface CategorizedMarkers {
	paths: string[];
	commands: string[];
	errors: string[];
	exact_values: string[];
	decisions: string[];
}

/** Categorize a block's text into salience buckets. Pure regex work, bounded O(n). */
export function categorize(text: string): CategorizedMarkers {
	const result: CategorizedMarkers = { paths: [], commands: [], errors: [], exact_values: [], decisions: [] };
	if (typeof text !== "string" || text.length === 0) return result;
	const seen = new Set<string>(); // global dedup across all categories
	const add = (bucket: string[], val: string): void => {
		const t = val.trim().slice(0, 80);
		if (!t || seen.has(t) || bucket.length >= PER_BLOCK_CAP) return;
		seen.add(t);
		bucket.push(t);
	};

	for (const m of text.matchAll(
		/\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|svelte|rs|py|go|java|rb|yml|yaml|toml|sh|env|log|conf|cfg|txt|sql|proto|lock)\b/g,
	)) {
		add(result.paths, m[0]);
	}
	for (const m of text.matchAll(/(?:^|\s)((?:\.{1,2}|src|lib|app|dist|build|test|scripts?)\/[\w./-]+)/gm)) {
		add(result.paths, m[1]);
	}

	for (const m of text.matchAll(/^\s*\$\s+(.+)/gm)) add(result.commands, m[1].slice(0, 80));
	for (const m of text.matchAll(
		/\b(?:npm|npx|pnpm|yarn|bun|node|git|docker|kubectl|make|cargo|go|python3?|pytest|deno|uv|gh)\s+\S[^\n.!?;]{0,60}/g,
	)) {
		add(result.commands, m[0].trim());
	}

	// Compound names (ImportError, ModuleNotFoundError, ValueError, RuntimeException, …) have no word
	// boundary before "Error", so `\bError` misses them — match the whole PascalCase name instead.
	// The plain-word list is deliberately broad and any-case: test runners say "3 failed", tools
	// print "fatal:", CI says "Aborted" — a failure signal in any of those spellings must count as
	// error-shaped (this detector feeds the gate's never-fold-a-short-error threshold AND the
	// pointer's kept-verbatim risk lines; a missed spelling is the rtk failure mode).
	for (const m of text.matchAll(
		/(?:\b(?:[A-Z][A-Za-z]*(?:Error|Exception|Warning)|[Ee]rror|ERROR|FAIL(?:ED|URE)?|[Ff]ail(?:ed|ure)s?|FATAL|[Ff]atal|PANIC|[Pp]anic|[Aa]borted|exception|Traceback|ENOENT|ECONNREFUSED)\b|npm ERR!|Segmentation fault|core dumped|Permission denied|✗|✘)[: ]*[^\n]{0,60}/g,
	)) {
		add(result.errors, m[0].slice(0, 60));
	}
	if (/\s+at\s+\S+\s*\(/.test(text)) add(result.errors, "stack trace");

	for (const m of text.matchAll(/\b(\w[\w.-]*)[ \t]*[:=][ \t]*(\S+)/g)) {
		const key = m[1];
		const val = m[2];
		if (!VALUE_STOPWORDS.has(key.toLowerCase()) && val.length > 2 && val.length < 60) {
			add(result.exact_values, `${key}=${val}`);
		}
	}

	for (const m of text.matchAll(
		/[^.!?\n]{0,200}\b(?:decided|chose|standardized on|going with|will use|selected|picked)\b[^.!?\n]{0,200}/gi,
	)) {
		add(result.decisions, m[0].trim().slice(0, 80));
	}

	return result;
}

/** The risk categories present in a block's text. More flags ⇒ stickier (folded later). */
export function riskFlags(text: string): FactCategory[] {
	const cats = categorize(text);
	return RISK_CATEGORIES.filter((c) => cats[c].length > 0);
}

/** Build the structured fact ledger across all blocks — deduped, capped, category-priority order. */
export function harvestFacts(blocks: ViewBlock[], maxFacts = 24): ConductorFactLedgerEntry[] {
	const seen = new Set<string>();
	const byCat: Record<FactCategory, ConductorFactLedgerEntry[]> = {
		exact_values: [], decisions: [], commands: [], errors: [], paths: [],
	};
	for (const block of blocks) {
		if (block.text === undefined) continue;
		const cats = categorize(block.text);
		for (const cat of CATEGORY_ORDER) {
			for (const value of cats[cat]) {
				const key = `${cat}:${value.toLowerCase()}`;
				if (seen.has(key)) continue;
				seen.add(key);
				byCat[cat].push({ category: cat, value, turn: block.turn, sourceId: block.id });
			}
		}
	}
	const out: ConductorFactLedgerEntry[] = [];
	for (const cat of CATEGORY_ORDER) {
		for (const entry of byCat[cat]) {
			if (out.length >= maxFacts) return out;
			out.push(entry);
		}
	}
	return out;
}
