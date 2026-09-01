/*
 * handoff.test.ts — the opt-in handoff seed: deterministic index plus the stated goal, with
 * nothing in the file that a model wrote.
 */
import { describe, expect, it } from "vitest";
import { buildHandoffSeed } from "../src/adapters/pi/handoff";

const indexBody = "# Compaction summary (deterministic seed index — no model involved)\n- fact";

describe("handoff seed", () => {
	it("states the goal and carries the index verbatim", () => {
		const seed = buildHandoffSeed({ goal: "continue the migration in a fresh session", indexBody, at: "2026-07-28" });
		expect(seed).toContain("continue the migration in a fresh session");
		expect(seed).toContain(indexBody);
		expect(seed).toContain("extracted verbatim");
	});

	it("names the parent session file in the header, and marks codes as provenance", () => {
		const seed = buildHandoffSeed({
			goal: "g",
			indexBody,
			at: "2026-07-28",
			parentSessionPath: "/sessions/ws/s1.jsonl",
		});
		expect(seed).toContain("Parent session: /sessions/ws/s1.jsonl");
		expect(seed).toContain("not live handles");
	});

	it("omits the parent line when no session file is known", () => {
		const seed = buildHandoffSeed({ goal: "g", indexBody, at: "2026-07-28" });
		expect(seed).not.toContain("Parent session:");
	});

	it("says so plainly when no goal was given", () => {
		const seed = buildHandoffSeed({ goal: "", indexBody, at: "2026-07-28" });
		expect(seed).toContain("(not stated");
		expect(seed).toContain(indexBody);
	});
});
