import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import contextFold from "../../src/adapters/pi/index";

export default function (pi: ExtensionAPI): void {
	const record = (event: unknown) => appendFileSync(process.env.CF_WARNING_CHECK_LOG!, `${JSON.stringify(event)}\n`);
	pi.registerProvider("cache-warning-check", {
		apiKey: "offline",
		baseUrl: "http://127.0.0.1:1",
		api: "openai-completions",
		models: [{
			id: "fixture", name: "Offline warning fixture", reasoning: false, input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 1000,
		}],
		streamSimple: (_model, context) => {
			record({ provider: context });
			throw new Error("Offline fixture: reached provider boundary without a network request");
		},
	});
	pi.on("input", event => { record({ offered: event }); });
	contextFold(pi);
	pi.on("input", event => {
		record({ accepted: event });
		return { action: "continue" };
	});
}
