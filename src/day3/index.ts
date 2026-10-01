import { z } from "zod";

const MODEL = "llama3.2";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL_PROBE_TIMEOUT = 6000;

const TICKET = "Customer says they were charged twice for order A-4471 on the 3rd. They are quite upset and want the duplicate refunded today.";

const FIELDS = ["severity", "queue", "action", "owner", "sla_ack_minutes"] as const;
const VALID_SEVERITY = new Set(["S1", "S2", "S3", "S4"]);
const VALID_QUEUE = new Set(["payments", "logistics", "infra", "legal"]);
const VALID_ACTION = new Set(["assign", "escalate", "monitor"]);

const SCHEMA_TEXT = `{
  "severity":         "one of S1|S2|S3|S4",
  "queue":            "one of payments|logistics|infra|legal",
  "action":           "one of assign|escalate|monitor",
  "owner":            "a team name, lowercase, hyphenated",
  "sla_ack_minutes":  integer
}`;

type AskOptions = {
  num_predict?: number;
  temperature?: number;
};

async function ask(prompt: string, system?: string, fmt?: string | Record<string, unknown>, options?: AskOptions): Promise<{ text: string | null; error: string | null }> {
  try {
    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (system) {
      messages.push({ role: "system", content: system });
    }
    messages.push({ role: "user", content: prompt });

    const body: Record<string, unknown> = {
      model: MODEL,
      messages,
      stream: false,
    };

    if (fmt !== undefined) {
      body.format = fmt;
    }
    if (options) {
      body.options = options;
    }

    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      return { text: null, error: `ollama request failed (${res.status})` };
    }

    const data = (await res.json()) as { message?: { content?: string } };
    return {
      text: String(data.message?.content ?? "").trim(),
      error: null,
    };
  } catch (error) {
    return {
      text: null,
      error: `model unreachable (${error instanceof Error ? error.name : "Error"})`,
    };
  }
}

function extractJson(text: string | null): { value: Record<string, unknown> | null; error: string | null } {
  if (text === null) {
    return { value: null, error: "no output" };
  }

  const fenced = text.match(/```(?:json)?\s*(.*?)```/s);
  const candidate = fenced ? fenced[1] : text;
  const brace = candidate.match(/\{.*\}/s);
  if (!brace) {
    return { value: null, error: "no JSON object found in output" };
  }

  try {
    return { value: JSON.parse(brace[0]), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown parse error";
    return { value: null, error: `invalid JSON: ${message}` };
  }
}

function validate(obj: unknown): string[] {
  const problems: string[] = [];

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return ["top level is not an object"];
  }

  const record = obj as Record<string, unknown>;

  for (const f of FIELDS) {
    if (!(f in record)) {
      problems.push(`missing field: ${f}`);
    }
  }

  if (record.severity !== undefined && !VALID_SEVERITY.has(String(record.severity))) {
    problems.push(`severity ${JSON.stringify(record.severity)} not in ${JSON.stringify([...VALID_SEVERITY].sort())}`);
  }

  if (record.queue !== undefined && !VALID_QUEUE.has(String(record.queue))) {
    problems.push(`queue ${JSON.stringify(record.queue)} not in ${JSON.stringify([...VALID_QUEUE].sort())}`);
  }

  if (record.action !== undefined && !VALID_ACTION.has(String(record.action))) {
    problems.push(`action ${JSON.stringify(record.action)} not in ${JSON.stringify([...VALID_ACTION].sort())}`);
  }

  const sla = record.sla_ack_minutes;
  if (sla !== undefined && (typeof sla !== "number" || !Number.isInteger(sla))) {
    problems.push(`sla_ack_minutes is ${typeof sla}, expected int`);
  }

  const extra = Object.keys(record).filter((key) => !(FIELDS as readonly string[]).includes(key));
  if (extra.length > 0) {
    problems.push(`unexpected fields: ${extra}`);
  }

  return problems;
}

const TicketSchema = z.object({
  severity: z.enum(["S1", "S2", "S3", "S4"]),
  queue: z.enum(["payments", "logistics", "infra", "legal"]),
  action: z.enum(["assign", "escalate", "monitor"]),
  owner: z.string().regex(/^[a-z-]+$/),
  sla_ack_minutes: z.number().int().positive(),
}).strict();

const TicketJsonSchema = {
  type: "object",
  properties: {
    severity: { type: "string", enum: ["S1", "S2", "S3", "S4"], description: "Severity level of the ticket" },
    queue: { type: "string", enum: ["payments", "logistics", "infra", "legal"], description: "Queue to which the ticket belongs" },
    action: { type: "string", enum: ["assign", "escalate", "monitor"], description: "Action to be taken for the ticket" },
    owner: { type: "string", pattern: "^[a-z-]+$", description: "Owner of the ticket" },
    sla_ack_minutes: { type: "integer", minimum: 1, description: "SLA acknowledgment time in minutes" },
  },
  required: ["severity", "queue", "action", "owner", "sla_ack_minutes"],
  additionalProperties: false,
} as const;

function zodValidationExample(): void {
  const validTicket = {
    severity: "S2",
    queue: "payments",
    action: "escalate",
    owner: "service-desk",
    sla_ack_minutes: 30,
  };

  const invalidTicket = {
    severity: "high",
    queue: "billing",
    sla_ack_minutes: "30",
  };

  const prettyValid = JSON.stringify(validTicket, null, 2);
  const prettyInvalid = JSON.stringify(invalidTicket, null, 2);

  console.log("\n  --- ZOD VALIDATION EXAMPLE ---");
  console.log("  valid JSON payload:\n" + prettyValid);
  console.log("\n  invalid JSON payload:\n" + prettyInvalid);

  const validResult = TicketSchema.safeParse(validTicket);
  const invalidResult = TicketSchema.safeParse(invalidTicket);

  console.log("\n  ZOD valid result:");
  console.log(validResult.success ? "  ok -> " + JSON.stringify(validResult.data) : "  failed -> " + JSON.stringify(validResult.error.flatten(), null, 2));

  console.log("\n  ZOD invalid result:");
  console.log(invalidResult.success ? "  ok -> " + JSON.stringify(invalidResult.data) : "  failed -> " + JSON.stringify(invalidResult.error.flatten(), null, 2));
}

async function zodPromptExample(): Promise<void> {
  const { text, error } = await ask(
    `Triage this support ticket and return ONLY the JSON object matching the schema below.\n\nTICKET: ${TICKET}\n\nSCHEMA:\n${JSON.stringify(TicketJsonSchema, null, 2)}\n\nReturn only valid JSON. Do not add explanations or markdown fences.`,
    "You output JSON only.",
    TicketJsonSchema,
  );

  console.log("\n  --- ZOD + OLLAMA PROMPT EXAMPLE ---");
  if (error) {
    console.log(`  [${error}]`);
    return;
  }

  console.log("  RAW OUTPUT:");
  console.log(`    ${text?.replace(/\n/g, "\n    ") ?? ""}`);

  const parsed = extractJson(text);
  if (parsed.error) {
    console.log(`  PARSE : FAILED - ${parsed.error}`);
    return;
  }

  const result = TicketSchema.safeParse(parsed.value);
  if (!result.success) {
    console.log("  VALID : FAILED");
    console.log(JSON.stringify(result.error.flatten(), null, 2));
    return;
  }

  console.log("  VALID : ok -> " + JSON.stringify(result.data));
}

function report(label: string, raw: string | null, err: string | null): Record<string, unknown> | null {
  console.log(`\n  --- ${label} ---`);
  if (err) {
    console.log(`  [${err}]`);
    return null;
  }

  const shown = raw && raw.length < 320 ? raw : `${raw?.slice(0, 320) ?? ""} ...`;
  console.log("  RAW OUTPUT:");
  console.log(`    ${shown.replace(/\n/g, "\n    ")}`);

  const { value, error } = extractJson(raw);
  if (error) {
    console.log(`  PARSE : FAILED - ${error}`);
    return null;
  }

  const problems = validate(value);
  console.log("  PARSE : ok");
  if (problems.length > 0) {
    console.log("  VALID : FAILED");
    for (const p of problems) {
      console.log(`          - ${p}`);
    }
    return null;
  }

  console.log(`  VALID : ok -> ${JSON.stringify(value)}`);
  return value;
}

async function rung1(): Promise<Record<string, unknown> | null> {
  const { text, error } = await ask(`Triage this support ticket and return JSON.\n\nTICKET: ${TICKET}`);
  return report("RUNG 1  ask nicely", text, error);
}

async function rung2(): Promise<Record<string, unknown> | null> {
  const { text, error } = await ask(`Triage this support ticket.\n\nTICKET: ${TICKET}\n\nReturn ONLY a JSON object with exactly these fields and no others:\n${SCHEMA_TEXT}\nNo explanation, no code fence.`);
  return report("RUNG 2  constrain with an explicit schema", text, error);
}

async function rung3(): Promise<Record<string, unknown> | null> {
  const { text, error } = await ask(
    `Triage this support ticket.\n\nTICKET: ${TICKET}\n\nFields:\n${SCHEMA_TEXT}`,
    "You output JSON only.",
    "json",
  );
  return report("RUNG 3  the model's JSON mode", text, error);
}

async function rung5(): Promise<Record<string, unknown> | null> {
  const first = await ask(`Triage this support ticket and return JSON.\n\nTICKET: ${TICKET}`);
  if (first.error) {
    console.log(`\n  [${first.error}]`);
    return null;
  }

  const parsed = extractJson(first.text);
  const problems = parsed.error ? [parsed.error] : validate(parsed.value ?? {});

  if (problems.length === 0) {
    console.log("\n  --- RUNG 5  repair ---\n  first attempt was already valid, nothing to repair");
    return parsed.value;
  }

  console.log("\n  --- RUNG 5  repair ---");
  console.log("  first attempt failed validation:");
  for (const p of problems) {
    console.log(`          - ${p}`);
  }

  const repair = await ask(
    `Your previous output was rejected.\n\nOUTPUT:\n${first.text}\n\nERRORS:\n${problems.map((p) => `- ${p}`).join("\n")}\n\nReturn ONLY corrected JSON matching:\n${SCHEMA_TEXT}`,
    "You output JSON only.",
    "json",
  );

  return report("RUNG 5  after one repair attempt", repair.text, repair.error);
}

async function ladder(): Promise<void> {
  console.log("=".repeat(74));
  console.log("  THE RELIABILITY LADDER - same ticket, five rungs");
  console.log("=".repeat(74));

  const results = {
    "rung 1 ask": (await rung1()) !== null,
    "rung 2 schema": (await rung2()) !== null,
    "rung 3 json mode": (await rung3()) !== null,
    "rung 5 repair": (await rung5()) !== null,
  };

  console.log("\n" + "=".repeat(74));
  for (const [key, value] of Object.entries(results)) {
    console.log(`  ${key.padEnd(20)} ${value ? "VALID" : "not usable"}`);
  }
  console.log(`
  Rung 4 (validate) is not in this table because it is not an alternative -
  it is what produced the verdicts. You need it whichever rung you stop at.
  Results vary between runs: that is the point. An approach that works once
  is not a reliability strategy.`);
}

async function fewshot(): Promise<void> {
  const plain = await ask(`Classify the severity of this ticket. Answer with one word.\n\nTICKET: ${TICKET}`);
  const shots = `Examples:\nTICKET: Checkout is down for all customers. -> S1\nTICKET: One customer cannot apply a discount code. -> S3\nTICKET: Customer double-charged, wants refund today. -> S2\nTICKET: Typo on the returns page. -> S4\n\n`;
  const withex = await ask(`${shots}Classify the severity of this ticket. Answer with one word.\n\nTICKET: ${TICKET}`);

  console.log(`\n  --- zero-shot ---\n    ${plain.text ?? ""}`);
  console.log(`\n  --- with four examples ---\n    ${withex.text ?? ""}`);

  const bothBad = ![
    String(plain.text ?? "").trim().toUpperCase(),
    String(withex.text ?? "").trim().toUpperCase(),
  ].some((value) => ["S1", "S2", "S3", "S4"].includes(value));

  console.log(`
  Few-shot examples do two jobs: they show the FORMAT you want, and they
  calibrate the JUDGEMENT - "S2" means whatever your examples say it means.`);

  if (bothBad) {
    console.log(`
  BUT LOOK AT WHAT JUST HAPPENED. Four worked examples, every one of them
  answering with an S-code, and the model still replied in its own vocabulary.
  On a small model, examples NUDGE - they do not CONSTRAIN.

  That is the whole argument of this session in one result: no amount of
  prompt craft removes the need for rung 4. You validate the output and you
  reject what does not conform, because the prompt is a request, not a
  guarantee. Add an explicit instruction and an allowed-values list, and you
  move from hoping to checking.`);
  }
}

async function selftest(): Promise<number> {
  console.log("=".repeat(66));
  console.log("  SELFTEST");
  console.log("=".repeat(66));

  const probe: { ok?: boolean } = {};
  const timer = setTimeout(() => {
    probe.ok = false;
  }, MODEL_PROBE_TIMEOUT);

  try {
    const result = await ask("hi", undefined, undefined, { num_predict: 1 });
    if (!result.error) {
      probe.ok = true;
    } else {
      probe.ok = false;
    }
  } catch {
    probe.ok = false;
  } finally {
    clearTimeout(timer);
  }

  if (probe.ok) {
    console.log(`  local model : ${MODEL} reachable`);
  } else {
    console.log("  local model : unreachable - this session needs one, see the pre-read");
  }

  const ok = validate({ severity: "S2", queue: "payments", action: "escalate", owner: "service-desk", sla_ack_minutes: 30 });
  const bad = validate({ severity: "high", queue: "billing", sla_ack_minutes: "30" });

  console.log(`  validator   : clean object -> ${ok.length} problems (expect 0)`);
  console.log(`                broken object -> ${bad.length} problems (expect 4+)`);
  console.log(`  fields      : ${FIELDS.join(", ")}`);
  console.log(`\n  ${(!ok.length && bad.length > 0) ? "SELFTEST OK" : "SELFTEST FAILED"}`);

  return (!ok.length && bad.length > 0) ? 0 : 1;
}

function parseArgs(argv: string[]): string {
  const flags = new Set(argv);
  if (flags.has("--selftest")) return "selftest";
  if (flags.has("--naive")) return "naive";
  if (flags.has("--schema")) return "schema";
  if (flags.has("--jsonmode")) return "jsonmode";
  if (flags.has("--repair")) return "repair";
  if (flags.has("--fewshot")) return "fewshot";
  if (flags.has("--zod")) return "zod";
  if (flags.has("--zodprompt")) return "zodprompt";
  return "ladder";
}

async function main(): Promise<void> {
  const mode = parseArgs(process.argv.slice(2));

  switch (mode) {
    case "selftest": {
      process.exitCode = await selftest();
      return;
    }
    case "naive": {
      await rung1();
      return;
    }
    case "schema": {
      await rung2();
      return;
    }
    case "jsonmode": {
      await rung3();
      return;
    }
    case "repair": {
      await rung5();
      return;
    }
    case "fewshot": {
      await fewshot();
      return;
    }
    case "zod": {
      zodValidationExample();
      return;
    }
    case "zodprompt": {
      await zodPromptExample();
      return;
    }
    default: {
      await ladder();
      return;
    }
  }
}

await main();
console.log();
