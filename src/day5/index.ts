const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.LOCAL_MODEL || "llama3.2";
const TIMEOUT_MS = 30_000;

interface TextModel {
  readonly name: string;
  complete(prompt: string, system?: string): Promise<string>;
}

type ChatMessage = { role: "system" | "user"; content: string };
type OllamaResponse = { message?: { content?: unknown } };
type ModelConfig = { fake?: boolean; fakeReply?: string; model?: string };

class OllamaModel implements TextModel {
  constructor(private readonly model = MODEL) {}

  get name(): string {
    return `ollama:${this.model}`;
  }

  async complete(prompt: string, system?: string): Promise<string> {
    const messages: ChatMessage[] = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, messages, stream: false }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as OllamaResponse;
      if (typeof data.message?.content !== "string") {
        throw new Error("Ollama response did not contain message content");
      }
      return data.message.content.trim();
    } finally {
      clearTimeout(timer);
    }
  }
}

class FakeModel implements TextModel {
  readonly name = "fake";
  readonly calls: Array<{ prompt: string; system?: string }> = [];

  constructor(private readonly reply = "S2") {}

  async complete(prompt: string, system?: string): Promise<string> {
    this.calls.push({ prompt, system });
    return this.reply;
  }
}

function pickModel(config: ModelConfig = {}): TextModel {
  if (config.fake) return new FakeModel(config.fakeReply);
  return new OllamaModel(config.model);
}

async function triage(model: TextModel, ticket: string): Promise<string> {
  const system = "Classify severity as exactly one of S1, S2, S3, S4. Answer with the code only.";
  return (await model.complete(ticket, system)).split(/\s+/)[0]!.replace(/[.,:]/g, "");
}

async function selftest(): Promise<void> {
  console.log("=".repeat(66));
  console.log("  SELFTEST (TypeScript)");
  console.log("=".repeat(66));
  console.log(`  node        : ${process.version}`);
  console.log(`  fetch       : ${typeof fetch === "function" ? "built in, no dependency" : "MISSING"}`);

  const fake = new FakeModel("S1");
  const result = await triage(fake, "Checkout is down.");
  console.log(`  fake model  : triage returned ${result} after ${fake.calls.length} call (no network)`);

  let reachable = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: controller.signal });
    reachable = response.ok;
  } catch {
    // The offline fake path remains useful when Ollama is not running.
  } finally {
    clearTimeout(timer);
  }
  console.log(`  local model : ${reachable ? `${MODEL} reachable` : "unreachable - the fake path still works"}`);
  console.log("\n  SELFTEST OK");
}

async function main(): Promise<void> {
  if (process.argv.includes("--selftest")) {
    await selftest();
    return;
  }

  const model = pickModel({ fake: process.argv.includes("--fake") });
  console.log(`\n  using: ${model.name}`);
  const ticket = "Customer was charged twice for order A-4471 and wants it refunded today.";
  console.log(`  ticket: ${ticket}`);
  try {
    console.log(`  severity: ${await triage(model, ticket)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  [model unreachable: ${message}] - try --fake\n`);
  }
}

await main();