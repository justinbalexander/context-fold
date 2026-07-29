/*
 * handoff.test.ts — the opt-in A layer: seed assembly leads with the degradation warning,
 * deterministic index is always present, narrative is clearly marked untrusted.
 */
import { describe, expect, it } from "vitest";
import { buildHandoffSeed } from "../src/adapters/pi/handoff";

const indexBody = "# Compaction summary (deterministic seed index — no model involved)\n- fact";

describe("handoff seed", () => {
	it("leads with the degradation warning and carries goal + index", () => {
		const seed = buildHandoffSeed({ goal: "port the C layer", indexBody, narrative: null, at: "2026-07-28" });
		expect(seed.indexOf("degrade context")).toBeGreaterThan(-1);
		expect(seed.indexOf("degrade context")).toBeLessThan(seed.indexOf("port the C layer"));
		expect(seed).toContain(indexBody);
		expect(seed).toContain("deterministic seed above is the recommended form");
	});

	it("marks a model narrative untrusted and never replaces the index with it", () => {
		const seed = buildHandoffSeed({ goal: "", indexBody, narrative: "We did things.", at: "2026-07-28" });
		expect(seed).toContain("UNTRUSTED");
		expect(seed).toContain("We did things.");
		expect(seed).toContain(indexBody);
		expect(seed).toContain("(not stated");
	});
});
