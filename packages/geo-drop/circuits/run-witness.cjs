const fs = require("fs");
const path = require("path");

if (process.argv.length !== 5) {
  console.log("Usage: node run-witness.cjs <file.wasm> <input.json> <output.wtns>");
  process.exit(1);
}

const wasmPath = path.resolve(process.cwd(), process.argv[2]);
const inputPath = path.resolve(process.cwd(), process.argv[3]);
const outputPath = path.resolve(process.cwd(), process.argv[4]);
const witnessDirectory = path.dirname(wasmPath);
const witnessCalculatorSource = path.join(witnessDirectory, "witness_calculator.js");
const witnessCalculatorShim = path.join(witnessDirectory, "witness_calculator.cjs");

fs.copyFileSync(witnessCalculatorSource, witnessCalculatorShim);
const buildWitnessCalculator = require(witnessCalculatorShim);

async function main() {
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const wasmBuffer = fs.readFileSync(wasmPath);
  const witnessCalculator = await buildWitnessCalculator(wasmBuffer);
  const witnessBinary = await witnessCalculator.calculateWTNSBin(input, 0);
  fs.writeFileSync(outputPath, witnessBinary);
  console.log(`Witness written to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
