/*
 * recall-eval.ts — the Phase-3 experiment harness.
 *
 * Hypothesis: reversible folding preserves recall better than lossy compaction at the same token
 * budget, and a model writing the digests preserves more than the deterministic per-kind digest.
 *
 * Method: build a long, over-budget session with distinctive facts planted MID-BLOCK (not on line
 * 1, where the deterministic digest's first-line peek would trivially keep them). Compact it three
 * ways to the SAME budget, then measure:
 *   • retention — does the planted fact's needle still appear in the compacted context text?
 *   • recall    — can a driver model ANSWER the fact's question from the compacted context? (live)
 *   • tokens    — final context size.
 *
 * Arms:
 *   • truncate   — drop oldest whole messages until under budget (the "native /compact" lossy proxy:
 *                  old turns are simply gone, no recovery).
 *   • det-fold   — context-fold with the deterministic Keel policy (folds are reversible digests).
 *   • model-fold — context-fold with the ModelConductor + model digest writer + relevance judge.
 */
import type { AgentMessage } from "../core/block";
import { linearize } from "../core/block";
import { ContextFoldEngine } from "../adapters/pi/store";
import { KeelConductor } from "../core/policy/keel";
import { ModelConductor } from "../core/policy/model";
import { fetchDigestWriter, DEFAULT_WRITER_CONFIG } from "../core/model/digest-writer";
import { fetchRelevanceJudge, DEFAULT_JUDGE_CONFIG } from "../core/model/relevance-judge";

export interface PlantedFact {
	needle: string; // distinctive substring to find in the compacted context
	question: string; // the recall question for the driver model
	expected: string; // substring that must appear in a correct answer
	line: string; // the full planted line (placed mid-block)
}

export const FACTS: PlantedFact[] = [
	{ needle: "ZX-77automation", question: "What is the DEPLOY_TOKEN value?", expected: "ZX-77automation", line: "DEPLOY_TOKEN=ZX-77automation  # do not rotate before the cutover" },
	{ needle: "aurora.yaml", question: "What is the path of the main config file?", expected: "aurora.yaml", line: "loaded primary config from src/conf/aurora.yaml (sha 9f1c)" },
	{ needle: "8431", question: "What port does the shard coordinator listen on?", expected: "8431", line: "shard-coordinator bound and listening on port 8431 (ipv6 only)" },
	{ needle: "QRP-9", question: "Which wire protocol was chosen for inter-node traffic?", expected: "QRP-9", line: "team decided to standardize on the QRP-9 protocol for inter-node traffic" },
	{ needle: "E_4471", question: "What error code appeared on shard 3?", expected: "E_4471", line: "FATAL: replication error E_4471 on shard 3 during compaction" },
	{ needle: "2.14.7-rc3", question: "What version is the runtime pinned to?", expected: "2.14.7-rc3", line: "pinned the runtime to version 2.14.7-rc3 in the lockfile" },
];

let ts = 5_000;
const nextTs = () => ts++;

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: nextTs() };
}
function assistant(text: string, callId: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }, { type: "toolCall", id: callId, name: "bash", arguments: {} }],
		responseId: `r${nextTs()}`,
		model: "driver",
		timestamp: nextTs(),
	};
}
function toolResult(callId: string, lines: string[]): AgentMessage {
	return { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: lines.join("\n") }], isError: false, timestamp: nextTs() };
}

/** Filler lines that look like real log/build output but carry no planted fact. */
function filler(tag: string, n: number): string[] {
	return Array.from({ length: n }, (_, i) => `[${tag}] step ${i} ok — processed record ${i * 7 + 3} in 12ms, checksum ${(i * 2654435761) >>> 0}`);
}

/**
 * Build a long session of `steps` tool-call turns. The 6 facts are planted mid-block in evenly
 * spaced steps (early → late). Returns the messages and the facts (in planted order).
 */
export function buildSession(steps = 30): { messages: AgentMessage[]; facts: PlantedFact[] } {
	const out: AgentMessage[] = [user("Begin the migration project. Investigate the system and report findings as you go.")];
	const factSteps = FACTS.map((_, i) => Math.floor(((i + 0.5) / FACTS.length) * steps));
	for (let s = 0; s < steps; s++) {
		const callId = `call${s}`;
		out.push(user(`Step ${s}: inspect subsystem ${s} and run the relevant check.`));
		out.push(assistant(`Running the check for subsystem ${s}.`, callId));
		const lines = filler(`sub${s}`, 50);
		const fi = factSteps.indexOf(s);
		if (fi >= 0) lines.splice(25, 0, FACTS[fi].line); // plant the fact mid-block
		out.push(toolResult(callId, lines));
	}
	out.push(user("Now answer some questions about what you found earlier."));
	return { messages: out, facts: FACTS };
}

/** Total estimated tokens of a message array. */
export function tokensOf(messages: AgentMessage[]): number {
	return linearize(messages).reduce((n, b) => n + b.tokens, 0);
}

/** The "native /compact" lossy proxy: drop oldest whole messages until under budget (keep newest). */
export function truncateToBudget(messages: AgentMessage[], budget: number): AgentMessage[] {
	const kept = [...messages];
	while (kept.length > 1 && tokensOf(kept) > budget) kept.shift();
	return kept;
}

/** Concatenated, role-tagged text of a (possibly folded) context — what a reader/model would see. */
export function contextText(messages: AgentMessage[]): string {
	return linearize(messages)
		.map((b) => `[${b.kind}${b.toolName ? " " + b.toolName : ""}] ${b.text}`)
		.join("\n");
}

/** Fraction of facts whose needle survives verbatim in the compacted context. */
export function retention(messages: AgentMessage[], facts: PlantedFact[]): { score: number; hits: boolean[] } {
	const text = contextText(messages);
	const hits = facts.map((f) => text.includes(f.needle));
	return { score: hits.filter(Boolean).length / facts.length, hits };
}

export interface ModelConn {
	baseUrl: string;
	model: string;
	apiKey: string;
	disableThinking: boolean;
}

/** Build the model-fold engine, run it to convergence (writer/judge resolve), return folded messages. */
export async function modelFold(messages: AgentMessage[], cw: number, budgetFraction: number, conn: ModelConn): Promise<AgentMessage[]> {
	const writer = fetchDigestWriter({ ...DEFAULT_WRITER_CONFIG, ...conn, maxBlocks: 24 });
	const judge = fetchRelevanceJudge({ ...DEFAULT_JUDGE_CONFIG, ...conn });
	const engine = new ContextFoldEngine(new ModelConductor(), { budgetFraction, tailTarget: 1_000, defaultContextWindow: cw }, writer, judge);
	let out = engine.process(messages, cw);
	// Fire the async writer/judge, wait for them to settle, re-process so the model results apply.
	for (let i = 0; i < 30 && engine.busy; i++) await sleep(500);
	out = engine.process(messages, cw);
	for (let i = 0; i < 30 && engine.busy; i++) await sleep(500);
	out = engine.process(messages, cw);
	return out;
}

/** Deterministic fold (no model). */
export function detFold(messages: AgentMessage[], cw: number, budgetFraction: number): AgentMessage[] {
	const engine = new ContextFoldEngine(new KeelConductor(), { budgetFraction, tailTarget: 1_000, defaultContextWindow: cw });
	return engine.process(messages, cw);
}

/** Ask a driver model the question using ONLY the compacted context; return its answer text. */
export async function driveRecall(context: string, question: string, conn: ModelConn, maxTailChars = 60_000): Promise<string> {
	const ctx = context.length > maxTailChars ? context.slice(-maxTailChars) : context;
	const body: Record<string, unknown> = {
		model: conn.model,
		messages: [
			{ role: "system", content: "Answer the question using ONLY the provided context. Quote exact identifiers/values. If the answer is not in the context, reply exactly UNKNOWN." },
			{ role: "user", content: `CONTEXT:\n${ctx}\n\nQUESTION: ${question}` },
		],
		max_tokens: 60,
		temperature: 0,
		stream: false,
	};
	if (conn.disableThinking) body.chat_template_kwargs = { enable_thinking: false };
	try {
		const res = await fetch(`${conn.baseUrl.replace(/\/$/, "")}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${conn.apiKey}` },
			body: JSON.stringify(body),
		});
		if (!res.ok) return "";
		const json: any = await res.json();
		return (json?.choices?.[0]?.message?.content ?? "").toString();
	} catch {
		return "";
	}
}

export interface ArmResult {
	arm: string;
	tokens: number;
	retention: number;
	recall?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
