#!/usr/bin/env node

/**
 * GeoDropRegistryV2 deployment script for EVM testnets.
 *
 * Deploys:
 *   1. GeoDropRegistryV2 (implementation)
 *   2. GeoDropProxy(implementation, initialize(admin))
 *
 * Verifies by calling version() through the proxy.
 *
 * Usage:
 *   node deploy.mjs
 *
 * Environment variables (or .env file in this directory):
 *   RPC_URL        — JSON-RPC endpoint
 *   PRIVATE_KEY    — deployer wallet private key (hex)
 *   ADMIN_ADDRESS  — address to set as proxy admin
 *   CHAIN_NAME     — (optional) label for output file
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = resolve(__dirname, "..");
const DEPLOYMENTS_DIR = resolve(__dirname, "deployments");

// ---------------------------------------------------------------------------
// .env loader (zero-dependency)
// ---------------------------------------------------------------------------

function loadDotenv() {
  const envPath = resolve(__dirname, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

loadDotenv();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY?.replace(/^0x/, "");
const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS;
const CHAIN_NAME = process.env.CHAIN_NAME || "unknown";

if (!RPC_URL) abort("RPC_URL is required");
if (!PRIVATE_KEY) abort("PRIVATE_KEY is required");
if (!ADMIN_ADDRESS) abort("ADMIN_ADDRESS is required");
if (!/^[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)) abort("PRIVATE_KEY must be 64 hex characters");
if (!/^0x[0-9a-fA-F]{40}$/.test(ADMIN_ADDRESS)) abort("ADMIN_ADDRESS must be a valid Ethereum address");

// ---------------------------------------------------------------------------
// Compilation via solc (JSON standard input)
// ---------------------------------------------------------------------------

function compileSol() {
  log("Compiling contracts with solc...");

  const registrySrc = readFileSync(resolve(CONTRACTS_DIR, "GeoDropRegistryV2.sol"), "utf8");
  const proxySrc = readFileSync(resolve(CONTRACTS_DIR, "GeoDropProxy.sol"), "utf8");

  const input = {
    language: "Solidity",
    sources: {
      "GeoDropRegistryV2.sol": { content: registrySrc },
      "GeoDropProxy.sol": { content: proxySrc },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"],
        },
      },
    },
  };

  let output;
  try {
    const raw = execSync(`solc --standard-json`, {
      input: JSON.stringify(input),
      maxBuffer: 50 * 1024 * 1024,
      encoding: "utf8",
    });
    output = JSON.parse(raw);
  } catch (e) {
    // Try solcjs as fallback
    try {
      const raw = execSync(`solcjs --standard-json`, {
        input: JSON.stringify(input),
        maxBuffer: 50 * 1024 * 1024,
        encoding: "utf8",
      });
      output = JSON.parse(raw);
    } catch {
      abort(
        "solc not found. Install with: npm i -g solc\n" +
        "Or install the native binary: https://docs.soliditylang.org/en/latest/installing-solidity.html\n" +
        `Original error: ${e.message}`
      );
    }
  }

  if (output.errors) {
    const fatal = output.errors.filter((e) => e.severity === "error");
    if (fatal.length > 0) {
      console.error("Compilation errors:");
      for (const err of fatal) console.error(err.formattedMessage || err.message);
      abort("Compilation failed");
    }
    // Print warnings
    for (const w of output.errors.filter((e) => e.severity === "warning")) {
      console.warn(`  [warn] ${w.message}`);
    }
  }

  const registryContract = output.contracts["GeoDropRegistryV2.sol"]["GeoDropRegistryV2"];
  const proxyContract = output.contracts["GeoDropProxy.sol"]["GeoDropProxy"];

  if (!registryContract || !proxyContract) {
    abort("Compilation succeeded but contracts not found in output");
  }

  return {
    registry: {
      abi: registryContract.abi,
      bytecode: "0x" + registryContract.evm.bytecode.object,
    },
    proxy: {
      abi: proxyContract.abi,
      bytecode: "0x" + proxyContract.evm.bytecode.object,
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal JSON-RPC client (zero-dependency)
// ---------------------------------------------------------------------------

let rpcId = 1;

async function rpc(method, params = []) {
  const body = JSON.stringify({ jsonrpc: "2.0", method, params, id: rpcId++ });
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(`RPC error (${method}): ${json.error.message || JSON.stringify(json.error)}`);
  }
  return json.result;
}

// ---------------------------------------------------------------------------
// Minimal secp256k1 + RLP + transaction signing (via ethers.js if available,
// fallback to raw JSON-RPC eth_sendTransaction with unlocked account — but
// for testnet deployments we strongly recommend ethers)
// ---------------------------------------------------------------------------

let ethersAvailable = false;
let ethers;

try {
  ethers = await import("ethers");
  ethersAvailable = true;
} catch {
  // ethers not installed — will try raw approach
}

/**
 * Deploy a contract and return { address, txHash }.
 */
async function deployContract(bytecode, constructorArgs, label) {
  if (ethersAvailable) {
    return deployWithEthers(bytecode, constructorArgs, label);
  }
  return deployWithRawRpc(bytecode, constructorArgs, label);
}

async function deployWithEthers(bytecode, constructorArgs, label) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  log(`Deploying ${label} from ${wallet.address}...`);

  const factory = new ethers.ContractFactory([], bytecode, wallet);
  // Append constructor args manually if present
  let deployData = bytecode;
  if (constructorArgs) {
    deployData = bytecode + constructorArgs.replace(/^0x/, "");
  }

  const feeData = await provider.getFeeData();
  const nonce = await provider.getTransactionCount(wallet.address, "pending");

  const txReq = {
    data: deployData,
    nonce,
    ...(feeData.maxFeePerGas
      ? {
          type: 2,
          maxFeePerGas: feeData.maxFeePerGas * 2n,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || 1_000_000_000n,
        }
      : {
          gasPrice: feeData.gasPrice * 2n,
        }),
  };

  // Estimate gas
  const gasEstimate = await provider.estimateGas(txReq);
  txReq.gasLimit = (gasEstimate * 130n) / 100n; // 30% buffer

  log(`  Gas estimate: ${gasEstimate.toString()}, gas limit: ${txReq.gasLimit.toString()}`);

  const tx = await wallet.sendTransaction(txReq);
  log(`  TX sent: ${tx.hash}`);
  log(`  Waiting for confirmation...`);

  const receipt = await tx.wait(1);
  if (receipt.status !== 1) {
    abort(`${label} deployment failed (reverted). TX: ${tx.hash}`);
  }

  log(`  ${label} deployed at: ${receipt.contractAddress}`);
  return { address: receipt.contractAddress, txHash: tx.hash };
}

async function deployWithRawRpc(bytecode, constructorArgs, label) {
  // Derive address from private key using basic secp256k1
  // This path requires the RPC node to support eth_sendRawTransaction,
  // but without ethers we cannot sign. Fall back to eth_accounts-based
  // deployment (works with unlocked nodes like Hardhat/Anvil).

  log(`[raw RPC fallback] Deploying ${label}...`);
  log(`  WARNING: Raw RPC mode requires an unlocked account on the node.`);
  log(`  For testnet deployment, install ethers: npm i ethers`);

  const accounts = await rpc("eth_accounts");
  if (!accounts || accounts.length === 0) {
    abort(
      "No unlocked accounts available and ethers.js is not installed.\n" +
      "Install ethers.js: npm i ethers\n" +
      "Or use an RPC node with unlocked accounts (Hardhat, Anvil)."
    );
  }

  const from = accounts[0];
  let deployData = bytecode;
  if (constructorArgs) {
    deployData = bytecode + constructorArgs.replace(/^0x/, "");
  }

  const txHash = await rpc("eth_sendTransaction", [
    {
      from,
      data: deployData,
      gas: "0x" + (5_000_000).toString(16),
    },
  ]);

  log(`  TX sent: ${txHash}`);
  const receipt = await waitForReceipt(txHash);
  if (receipt.status !== "0x1") {
    abort(`${label} deployment failed (reverted). TX: ${txHash}`);
  }

  log(`  ${label} deployed at: ${receipt.contractAddress}`);
  return { address: receipt.contractAddress, txHash };
}

async function waitForReceipt(txHash, maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
    if (receipt) return receipt;
    await sleep(2000);
  }
  abort(`Timed out waiting for receipt: ${txHash}`);
}

// ---------------------------------------------------------------------------
// ABI encoding helpers
// ---------------------------------------------------------------------------

/**
 * Encode initialize(address) call data.
 * Selector: keccak256("initialize(address)") = 0xc4d66de8
 */
function encodeInitialize(adminAddr) {
  const selector = "c4d66de8";
  const addr = adminAddr.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  return "0x" + selector + addr;
}

/**
 * Encode the proxy constructor args: (address implementation, bytes initData)
 */
function encodeProxyConstructorArgs(implAddress, initData) {
  // ABI encode: (address, bytes)
  // address — padded to 32 bytes
  // bytes — offset (64 = 0x40), then length, then data padded to 32 bytes
  const addr = implAddress.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const initBytes = initData.replace(/^0x/, "");
  const initLen = (initBytes.length / 2).toString(16).padStart(64, "0");

  // Offset to the bytes data: 2 * 32 = 64 = 0x40
  const offset = "0000000000000000000000000000000000000000000000000000000000000040";

  // Pad initBytes to multiple of 32 bytes
  const padded = initBytes.padEnd(Math.ceil(initBytes.length / 64) * 64, "0");

  return "0x" + addr + offset + initLen + padded;
}

/**
 * Encode version() call data.
 * Selector: keccak256("version()") = 0x54fd4d50
 */
function encodeVersionCall() {
  return "0x54fd4d50";
}

// ---------------------------------------------------------------------------
// Verification: call version() through proxy
// ---------------------------------------------------------------------------

async function verifyDeployment(proxyAddress) {
  log("Verifying deployment by calling version() through proxy...");

  const result = await rpc("eth_call", [
    { to: proxyAddress, data: encodeVersionCall() },
    "latest",
  ]);

  const version = parseInt(result, 16);
  if (version !== 2) {
    abort(`version() returned ${version}, expected 2. Deployment may be broken.`);
  }

  log(`  version() = ${version} — OK`);
  return version;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("=== GeoDropRegistryV2 Deployment ===");
  log(`Network:  ${CHAIN_NAME}`);
  log(`RPC:      ${RPC_URL}`);
  log(`Admin:    ${ADMIN_ADDRESS}`);
  log("");

  // Get chain ID
  const chainIdHex = await rpc("eth_chainId");
  const chainId = parseInt(chainIdHex, 16);
  log(`Chain ID: ${chainId}`);

  // Compile
  const compiled = compileSol();
  log(`Registry bytecode: ${compiled.registry.bytecode.length / 2 - 1} bytes`);
  log(`Proxy bytecode:    ${compiled.proxy.bytecode.length / 2 - 1} bytes`);
  log("");

  // Step 1: Deploy implementation
  const impl = await deployContract(
    compiled.registry.bytecode,
    null,
    "GeoDropRegistryV2 (implementation)"
  );
  log("");

  // Step 2: Deploy proxy with initialize(admin)
  const initData = encodeInitialize(ADMIN_ADDRESS);
  const proxyConstructorArgs = encodeProxyConstructorArgs(impl.address, initData);
  const proxy = await deployContract(
    compiled.proxy.bytecode,
    proxyConstructorArgs,
    "GeoDropProxy"
  );
  log("");

  // Step 3: Verify
  const version = await verifyDeployment(proxy.address);
  log("");

  // Step 4: Save output
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = {
    network: CHAIN_NAME,
    chainId,
    rpcUrl: RPC_URL,
    adminAddress: ADMIN_ADDRESS,
    implementation: {
      address: impl.address,
      txHash: impl.txHash,
    },
    proxy: {
      address: proxy.address,
      txHash: proxy.txHash,
    },
    version,
    deployedAt: new Date().toISOString(),
  };

  mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const outFile = resolve(DEPLOYMENTS_DIR, `${CHAIN_NAME}-${timestamp}.json`);
  writeFileSync(outFile, JSON.stringify(output, null, 2) + "\n");
  log(`Deployment output saved to: ${outFile}`);

  log("");
  log("=== Deployment Complete ===");
  log(`  Proxy (interact with this): ${proxy.address}`);
  log(`  Implementation:             ${impl.address}`);
  log(`  Admin:                      ${ADMIN_ADDRESS}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  console.log(msg);
}

function abort(msg) {
  console.error(`\nERROR: ${msg}`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("\nUnexpected error:", err);
  process.exit(1);
});
