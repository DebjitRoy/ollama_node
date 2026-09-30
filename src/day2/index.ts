import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const MODEL = "llama3.2";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const CONSTRAINTS = ["capability", "latency", "privacy", "cost"] as const;
type Constraint = (typeof CONSTRAINTS)[number];
type Ratings = Record<Constraint, number>;
type Scenario = { name: string; weights: Ratings; floors: Partial<Ratings> };

const PROFILE: Record<string, Ratings> = {
  "hosted frontier": { capability: 5, latency: 4, privacy: 1, cost: 2 },
  "hosted small": { capability: 3, latency: 5, privacy: 1, cost: 4 },
  "local open": { capability: 3, latency: 3, privacy: 5, cost: 5 },
  "local + hosted": { capability: 4, latency: 4, privacy: 4, cost: 4 },
};

const SCENARIOS: Scenario[] = [
  {
    name: "Customer support assistant over public policy docs",
    weights: { capability: 2, latency: 4, privacy: 2, cost: 5 },
    floors: {},
  },
  {
    name: "Summarising patient records inside a hospital network",
    weights: { capability: 3, latency: 2, privacy: 5, cost: 3 },
    floors: { privacy: 4 },
  },
  {
    name: "Drafting complex legal argument from case law",
    weights: { capability: 5, latency: 1, privacy: 4, cost: 2 },
    floors: { capability: 5 },
  },
  {
    name: "Classifying 2 million support tickets overnight",
    weights: { capability: 2, latency: 1, privacy: 3, cost: 5 },
    floors: {},
  },
  {
    name: "Public-facing chat, sub-second replies, low volume",
    weights: { capability: 3, latency: 5, privacy: 1, cost: 3 },
    floors: { latency: 5 },
  },
];

function score(weights: Ratings, floors: Partial<Ratings> = {}) {
  const ranked: Array<{ total: number; name: string; profile: Ratings }> = [];
  const blocked: Array<{ name: string; profile: Ratings; failures: Constraint[] }> = [];

  for (const [name, profile] of Object.entries(PROFILE)) {
    const failures = CONSTRAINTS.filter((constraint) => {
      const floor = floors[constraint];
      return floor !== undefined && profile[constraint] < floor;
    });
    if (failures.length > 0) {
      blocked.push({ name, profile, failures });
    } else {
      const total = CONSTRAINTS.reduce((sum, constraint) => sum + profile[constraint] * weights[constraint], 0);
      ranked.push({ total, name, profile });
    }
  }

  ranked.sort((left, right) => right.total - left.total);
  return { ranked, blocked };
}

function showScores(title: string, weights: Ratings, floors: Partial<Ratings> = {}): void {
  const { ranked, blocked } = score(weights, floors);
  console.log(`\n  ${title}`);
  console.log(`  weights : ${CONSTRAINTS.map((constraint) => `${constraint}=${weights[constraint]}`).join("  ")}`);
  if (Object.keys(floors).length > 0) {
    console.log(`  FLOORS  : ${Object.entries(floors).map(([constraint, value]) => `${constraint} >= ${value}`).join("  ")} (disqualifying)`);
  }
  console.log("  " + "-".repeat(78));
  console.log(`  ${"option".padEnd(18)}${"cap".padStart(5)}${"lat".padStart(5)}${"priv".padStart(6)}${"cost".padStart(6)}${"score".padStart(8)}`);

  for (const row of ranked) {
    const profile = row.profile;
    console.log(`  ${row.name.padEnd(18)}${String(profile.capability).padStart(5)}${String(profile.latency).padStart(5)}${String(profile.privacy).padStart(6)}${String(profile.cost).padStart(6)}${String(row.total).padStart(8)}`);
  }
  for (const row of blocked) {
    const profile = row.profile;
    console.log(`  ${row.name.padEnd(18)}${String(profile.capability).padStart(5)}${String(profile.latency).padStart(5)}${String(profile.privacy).padStart(6)}${String(profile.cost).padStart(6)}  RULED OUT (${row.failures.join(", ")})`);
  }
  console.log(ranked.length > 0 ? `\n  -> ${ranked[0]?.name} (score ${ranked[0]?.total})` : "\n  -> nothing qualifies; revisit the floors");
}

function scenarios(): void {
  for (const scenario of SCENARIOS) {
    showScores(scenario.name, scenario.weights, scenario.floors);
  }
  console.log("\n  The winner changes by engagement; there is no permanent hosted-or-local answer.\n");
}

function portable(): void {
  console.log(`
  interface TextModel { complete(prompt, system?) -> string }
  class OllamaModel implements TextModel { ... }
  class HostedModel implements TextModel { ... }
  const model = pickModel(config);
  const answer = await model.complete(prompt);

  Keep provider calls behind one interface: the choice stays reversible,
  tests can use a fake, and routing can happen per request.\n`);
}

async function latency(runs: number): Promise<void> {
  console.log(`\n  Measuring ${MODEL} on this machine. ${runs} runs, up to 32 generated tokens.`);
  console.log("  First run may include model loading.\n");
  const firstTokens: number[] = [];
  const totals: number[] = [];

  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    try {
      const response = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, prompt: "Explain a refund policy in one sentence.", stream: true, options: { num_predict: 32 } }),
      });
      if (!response.ok || !response.body) {
        console.log(`  [ollama request failed (${response.status})]`);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let firstToken: number | undefined;
      let done = false;
      while (!done) {
        const chunk = await reader.read();
        pending += decoder.decode(chunk.value, { stream: !chunk.done });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const part = JSON.parse(line) as { response?: string; done?: boolean };
          if (part.response && firstToken === undefined) firstToken = (performance.now() - start) / 1000;
          done = Boolean(part.done);
        }
        done ||= chunk.done;
      }
      const total = (performance.now() - start) / 1000;
      firstTokens.push(firstToken ?? total);
      totals.push(total);
      console.log(`  run ${index + 1}: first token ${(firstToken ?? total).toFixed(2)}s   total ${total.toFixed(2)}s${index === 0 ? "  (cold-start candidate)" : ""}`);
    } catch (error) {
      console.log(`  [model unreachable (${error instanceof Error ? error.name : "Error"})]`);
      return;
    }
  }

  const median = (values: number[]) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };
  const warmFirst = firstTokens.slice(1);
  const warmTotal = totals.slice(1);
  console.log(`\n  warm median: first token ${median(warmFirst.length > 0 ? warmFirst : firstTokens).toFixed(2)}s, total ${median(warmTotal.length > 0 ? warmTotal : totals).toFixed(2)}s\n`);
}

async function decide(): Promise<void> {
  const prompt = createInterface({ input: stdin, output: stdout });
  const weights = {} as Ratings;
  try {
    for (const constraint of CONSTRAINTS) {
      const input = await prompt.question(`  ${constraint} (0-5, default 3): `);
      const value = Number.parseInt(input, 10);
      weights[constraint] = Number.isFinite(value) ? Math.max(0, Math.min(5, value)) : 3;
    }
  } finally {
    prompt.close();
  }
  showScores("your engagement", weights);
}

async function selftest(): Promise<void> {
  console.log("=".repeat(66));
  console.log("  DAY 2 MODEL CHOICE SELFTEST");
  console.log("=".repeat(66));
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(6000) });
    console.log(`  local model : ${response.ok ? `${MODEL} endpoint reachable (latency demo available)` : "unreachable (scoring still runs)"}`);
  } catch {
    console.log("  local model : unreachable (scoring still runs)");
  }
  console.log(`  constraints : ${CONSTRAINTS.join(", ")}`);
  console.log(`  options     : ${Object.keys(PROFILE).length}   scenarios: ${SCENARIOS.length}`);
  console.log("\n  SELFTEST OK (only --latency needs a model)");
}

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  if (flags.has("--selftest")) return selftest();
  if (flags.has("--latency")) {
    const runsArg = process.argv.slice(2).find((argument) => argument.startsWith("--runs="));
    const runs = Math.max(1, Number.parseInt(runsArg?.split("=")[1] ?? "3", 10) || 3);
    return latency(runs);
  }
  if (flags.has("--decide")) return decide();
  if (flags.has("--portable")) return portable();
  scenarios();
}

await main();