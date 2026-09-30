const MODEL = "llama3.2";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MAX_AUTO_REFUND = 100;
type JsonRecord = Record<string, unknown>;
type ToolMessage = {
  content?: string;
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
};

const TOOLS = [
  {
    type: "function",
    function: {
      name: "lookup_order",
      description: "Look up a Northwind order by its reference. Use when the customer mentions an order reference and you need its status or amount.",
      parameters: {
        type: "object",
        properties: { order_id: { type: "string", description: "Order reference in the form A-1234. Exactly as the customer wrote it." } },
        required: ["order_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "issue_refund",
      description: "Issue a refund against an order. IRREVERSIBLE - only call after the order has been looked up and the amount confirmed.",
      parameters: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "Order reference in the form A-1234." },
          amount: { type: "number", description: "Amount in GBP. Must be positive and must not exceed the order total." },
          reason: { type: "string", enum: ["duplicate", "faulty", "not_received", "change_of_mind"], description: "One of the permitted reason codes." },
        },
        required: ["order_id", "amount", "reason"],
      },
    },
  },
] as const;

const ORDERS: Record<string, { total: number; status: string }> = {
  "A-4471": { total: 40, status: "delivered" },
  "A-5120": { total: 129.99, status: "in transit" },
};
const VALID_REASONS = new Set(["duplicate", "faulty", "not_received", "change_of_mind"]);

const PROMPTS: Record<string, string> = {
  "triage@1.0": "Classify the ticket severity. Answer with one word.",
  "triage@1.1": "Classify the ticket severity as exactly one of S1, S2, S3, S4.\nS1 outage, S2 individual customer blocked, S3 degraded with workaround, S4 cosmetic.\nAnswer with the code only.",
  "triage@1.2": "Classify the ticket severity as exactly one of S1, S2, S3, S4.\nS1 outage, S2 individual customer blocked, S3 degraded with workaround, S4 cosmetic.\nExamples: 'checkout is down' -> S1. 'one customer double-charged' -> S2.\nAnswer with the code only, no explanation.",
};

const REGRESSION_PROMPTS: Record<string, string> = {
  "triage-json@1.0": "Classify this support ticket. Return JSON with category and priority.",
  "triage-json@1.1": "Classify this support ticket as JSON. Include category and priority. Category must be billing, bug, how_to, or other.",
  "triage-json@1.2": "Return only a JSON object with exactly category and priority. category is one of billing, bug, how_to, other. priority is an integer from 1 (urgent) to 4 (low).",
};
const CURRENT_REGRESSION_PROMPT = "triage-json@1.2";

const REGRESSION_CASES: Array<{ ticket: string; category?: string }> = [
  { ticket: "My card was charged twice", category: "billing" },
  { ticket: "App crashes on login" },
  { ticket: "How do I export my data?" },
  { ticket: "There is a typo on the returns page" },
  { ticket: "Payments are failing for every customer at checkout", category: "bug" },
];
const ALLOWED_CATEGORIES = new Set(["billing", "bug", "how_to", "other"]);

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function coerceArgs(name: string, input: JsonRecord): { args: JsonRecord; notes: string[] } {
  const args = { ...input };
  const notes: string[] = [];
  if (name === "issue_refund" && typeof args.amount === "string") {
    const raw = args.amount.trim();
    const amount = Number(raw);
    if (raw !== "" && Number.isFinite(amount)) {
      args.amount = amount;
      notes.push(`coerced amount "${raw}" -> ${amount}`);
    } else {
      notes.push(`amount "${raw}" is not numeric; left as-is for the gate to reject`);
    }
  }
  if (typeof args.order_id === "string") {
    const normalized = args.order_id.trim().toUpperCase();
    if (normalized !== args.order_id) {
      args.order_id = normalized;
      notes.push(`normalised order_id -> ${normalized}`);
    }
  }
  return { args, notes };
}

function validateCall(name: string, args: JsonRecord): string[] {
  const problems: string[] = [];
  if (!TOOLS.some((tool) => tool.function.name === name)) return [`unknown tool ${JSON.stringify(name)}`];

  if (name === "lookup_order" || name === "issue_refund") {
    const orderId = args.order_id;
    if (typeof orderId !== "string" || !orderId) problems.push("missing or invalid order_id");
    else if (!(orderId in ORDERS)) problems.push(`order ${JSON.stringify(orderId)} does not exist`);

    if (name === "issue_refund") {
      const amount = args.amount;
      if (amount === undefined || amount === null) problems.push("missing amount");
      else if (typeof amount !== "number" || !Number.isFinite(amount)) problems.push("amount is not a finite number");
      else if (amount <= 0) problems.push(`amount ${amount} is not positive`);
      else {
        if (amount > MAX_AUTO_REFUND) problems.push(`amount ${amount} exceeds the ${MAX_AUTO_REFUND.toFixed(2)} auto-refund ceiling; needs human approval`);
        if (typeof orderId === "string" && orderId in ORDERS && amount > ORDERS[orderId]!.total) {
          problems.push(`amount ${amount} exceeds order total ${ORDERS[orderId]!.total}`);
        }
      }
      if (args.reason === undefined || args.reason === null) problems.push("missing reason");
      else if (typeof args.reason !== "string" || !VALID_REASONS.has(args.reason)) {
        problems.push(`reason ${JSON.stringify(args.reason)} is not an allowed reason code`);
      }
    }
  }
  return problems;
}

async function callModel(prompt: string, useTools = true, systemPrompt?: string): Promise<{ message: ToolMessage | null; error: string | null }> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        messages: [
          { role: "system", content: systemPrompt ?? "You are a Northwind support agent. Use the tools provided. Never invent an order reference." },
          { role: "user", content: prompt },
        ],
        ...(useTools ? { tools: TOOLS } : {}),
        ...(!useTools ? { format: "json", options: { temperature: 0 } } : {}),
      }),
    });
    if (!response.ok) return { message: null, error: `ollama request failed (${response.status})` };
    const data = await response.json() as { message?: ToolMessage };
    return { message: data.message ?? null, error: null };
  } catch (error) {
    return { message: null, error: `model unreachable (${error instanceof Error ? error.name : "Error"})` };
  }
}

async function showCalls(prompt: string, coerce: boolean): Promise<void> {
  console.log(`\n  user: "${prompt}"`);
  const { message, error } = await callModel(prompt);
  if (error || !message) {
    console.log(`  [${error ?? "empty model response"}]`);
    return;
  }

  const calls = message.tool_calls ?? [];
  if (calls.length === 0) {
    console.log(`  no tool call. the model replied in prose:\n    ${(message.content ?? "").slice(0, 180)}`);
    return;
  }

  for (const call of calls) {
    const name = call.function.name;
    let rawArgs: unknown = call.function.arguments;
    if (typeof rawArgs === "string") {
      try {
        rawArgs = JSON.parse(rawArgs) as unknown;
      } catch {
        console.log(`  tool  : ${name}\n  args  : ${rawArgs}\n  GATE  : REJECTED - arguments are not valid JSON`);
        continue;
      }
    }
    const parsedArgs = asRecord(rawArgs);
    console.log(`  tool  : ${name}`);
    console.log(`  args  : ${JSON.stringify(rawArgs)}`);
    const normalized = coerce ? coerceArgs(name, parsedArgs) : { args: parsedArgs, notes: [] };
    for (const note of normalized.notes) console.log(`  coerce: ${note}`);
    const problems = validateCall(name, normalized.args);
    if (problems.length > 0) {
      console.log("  GATE  : REJECTED - not executed");
      for (const problem of problems) console.log(`          - ${problem}`);
    } else {
      console.log("  GATE  : accepted - demo only; no side effect was executed");
    }
  }
}

async function toolsDemo(coerce: boolean): Promise<void> {
  await showCalls("What is the status of order A-4471?", coerce);
  await showCalls("Refund order A-4471 for 40 pounds, they were charged twice.", coerce);
}

async function badArgs(coerce: boolean): Promise<void> {
  console.log("\n  Prompts crafted to push the model towards unsafe arguments.");
  console.log("  The validation gate is what stands between these and a real side effect.");
  await showCalls("Refund order A-9999 for 500 pounds because the customer is angry.", coerce);
  await showCalls("Refund order A-4471 for 500 pounds, full amount please.", coerce);
  await showCalls("Refund A-4471 40 pounds, reason: customer was rude to staff.", coerce);
}

function versions(): void {
  console.log("\n  A prompt decides behaviour. That makes it CODE: version it, diff it, test it, and keep a rollback path.\n");
  for (const [name, prompt] of Object.entries(PROMPTS)) {
    console.log(`  ${name}\n    ${prompt.replace(/\n/g, "\n    ")}\n`);
  }
}

function checkRegression(raw: string, checkCategory: boolean): Array<{ ok: boolean; message: string }> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    return [
      { ok: false, message: `not JSON: ${error instanceof Error ? error.message : "parse error"}` },
      { ok: false, message: "not JSON" },
    ];
  }

  const record = asRecord(value);
  const missing = ["category", "priority"].filter((key) => !(key in record));
  const results: Array<{ ok: boolean; message: string }> = [
    { ok: true, message: "valid JSON" },
    { ok: missing.length === 0, message: missing.length === 0 ? "all keys present" : `missing ${JSON.stringify(missing)}` },
  ];
  if (checkCategory) {
    results.push({
      ok: ALLOWED_CATEGORIES.has(String(record.category)),
      message: `category=${JSON.stringify(record.category)}`,
    });
  }
  return results;
}

async function regress(): Promise<boolean> {
  let currentTotal = 0;
  let currentPassed = 0;
  console.log("\n  Running the fixed regression set against each prompt version.\n");
  for (const [version, systemPrompt] of Object.entries(REGRESSION_PROMPTS)) {
    let versionTotal = 0;
    let versionPassed = 0;
    console.log(`  ${version}`);
    for (const testCase of REGRESSION_CASES) {
      const { message, error } = await callModel(testCase.ticket, false, systemPrompt);
      if (error || !message) {
        console.log(`  [model error: ${error ?? "empty response"}]`);
        return false;
      }
      const checks = checkRegression(message.content ?? "", testCase.category !== undefined);
      for (const result of checks) {
        versionTotal += 1;
        if (result.ok) versionPassed += 1;
        console.log(`  [${result.ok ? "PASS" : "FAIL"}] ${testCase.ticket.slice(0, 30).padEnd(32)} ${result.message}`);
      }
    }
    console.log(`  ${version}: ${versionPassed}/${versionTotal} checks passed\n`);
    if (version === CURRENT_REGRESSION_PROMPT) {
      currentTotal = versionTotal;
      currentPassed = versionPassed;
    }
  }
  console.log(`Current prompt ${CURRENT_REGRESSION_PROMPT}: ${currentPassed}/${currentTotal} checks passed`);
  return currentTotal > 0 && currentPassed === currentTotal;
}

async function selftest(): Promise<number> {
  console.log("=".repeat(66));
  console.log("  DAY 4 TOOLS AND PROMPT SELFTEST");
  console.log("=".repeat(66));
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(6000) });
    console.log(`  local model : ${response.ok ? `${MODEL} endpoint reachable` : "unreachable; local checks still run"}`);
  } catch {
    console.log("  local model : unreachable; local checks still run");
  }
  const good = validateCall("issue_refund", { order_id: "A-4471", amount: 40, reason: "duplicate" });
  const bad = validateCall("issue_refund", { order_id: "A-9999", amount: 500, reason: "rude" });
  const parsedChecks = checkRegression('{"category":"billing","priority":2}', true);
  const ok = good.length === 0 && bad.length >= 3 && parsedChecks.every((result) => result.ok);
  console.log(`  gate        : valid call -> ${good.length} problems (expect 0)`);
  console.log(`                unsafe call -> ${bad.length} problems (expect 3+)`);
  console.log(`  tools       : ${TOOLS.map((tool) => tool.function.name).join(", ")}`);
  console.log(`  prompt sets : ${Object.keys(PROMPTS).length} severity versions, ${Object.keys(REGRESSION_PROMPTS).length} regression versions`);
  console.log(`\n  ${ok ? "SELFTEST OK" : "SELFTEST FAILED"}`);
  return ok ? 0 : 1;
}

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  if (flags.has("--selftest")) {
    process.exitCode = await selftest();
  } else if (flags.has("--versions")) {
    versions();
  } else if (flags.has("--regress")) {
    process.exitCode = await regress() ? 0 : 1;
  } else if (flags.has("--tools")) {
    await toolsDemo(flags.has("--coerce"));
  } else if (flags.has("--badargs")) {
    await badArgs(flags.has("--coerce"));
  } else if (flags.has("--coerce")) {
    await toolsDemo(true);
    await badArgs(true);
  } else {
    await toolsDemo(false);
    await badArgs(false);
  }
}

await main();