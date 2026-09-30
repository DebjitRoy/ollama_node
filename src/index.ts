import { readFile } from "node:fs/promises";

type ModuleName = "day2" | "day3" | "day4";
type PackageConfig = { config?: { module?: string } };

const modules: Record<ModuleName, () => Promise<unknown>> = {
  day2: () => import("./day2/index.js"),
  day3: () => import("./day3/index.js"),
  day4: () => import("./day4/index.js"),
};

async function main(): Promise<void> {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as PackageConfig;
  const args = process.argv.slice(2);
  const requested = args[0] in modules ? args.shift() : packageJson.config?.module;

  if (!requested || !(requested in modules)) {
    console.error(`Unknown module "${requested ?? ""}". Set config.module in package.json to day2, day3, or day4.`);
    process.exitCode = 1;
    return;
  }

  process.argv = [process.argv[0] ?? "node", process.argv[1] ?? "", ...args];
  await modules[requested as ModuleName]();
}

await main();