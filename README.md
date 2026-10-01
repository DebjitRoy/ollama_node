# Shared TypeScript Ollama Labs

This project brings the TypeScript versions of the course exercises together. Each day's lab lives in its own folder under `src/`; the selected module is controlled by `config.module` in `package.json`.

## Setup

```bash
cd tsOllama
npm install
```

Ollama is only needed for model-backed commands. The default model is `llama3.2`; set `OLLAMA_URL` to use a different Ollama server.

## Choose a module

Set `config.module` in `package.json` to `day2`, `day3`, `day4`, or `day5`, then run:

```bash
npm start
```

The package defaults to `day3`. You can also launch a module without editing the selection:

```bash
npm run day2 -- --selftest
npm run day2 -- --scenarios
npm run day2 -- --latency
npm run day3 -- --selftest
npm run day3 -- --zodprompt
npm run day4 -- --selftest
npm run day4 -- --versions
npm run day4 -- --regress
npm run day4 -- --tools
npm run day4 -- --badargs
npm run day4 -- --coerce
npm run day5 -- --selftest
npm run day5 -- --fake
```

With no Day 2 option, the scenario comparison runs. Day 2 also supports `--decide`, `--portable`, and `--latency --runs=5`. Day 3 defaults to the reliability ladder and supports `--naive`, `--schema`, `--jsonmode`, `--repair`, `--fewshot`, `--zod`, and `--zodprompt`. Day 4's `--regress` checks a fixed ticket set against each versioned prompt; older prompt failures remain visible, while `triage-json@1.2` controls the command's exit status. The tool-call demos validate proposed arguments and never execute a refund. Day 5 demonstrates a swappable model interface; `--fake` runs offline with a deterministic reply.

## Build

```bash
npm run build
```

Add future course days as `src/dayN/index.ts` and register the module in `src/index.ts` before setting `config.module` to it.