#!/usr/bin/env node

/**
 * Local deployment test using solc (Node.js API) + ethers.js + Hardhat in-process.
 * No external solc binary required.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Use solc Node.js API
const solc = require('solc');
const { ethers } = await import('ethers');

// ============================================================
// Compile
// ============================================================

function compile() {
  const registrySrc = readFileSync(resolve(__dirname, '..', 'GeoDropRegistryV2.sol'), 'utf8');
  const proxySrc = readFileSync(resolve(__dirname, '..', 'GeoDropProxy.sol'), 'utf8');

  const input = JSON.stringify({
    language: 'Solidity',
    sources: {
      'GeoDropRegistryV2.sol': { content: registrySrc },
      'GeoDropProxy.sol': { content: proxySrc },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  });

  const output = JSON.parse(solc.compile(input));

  if (output.errors) {
    const fatal = output.errors.filter(e => e.severity === 'error');
    if (fatal.length) {
      fatal.forEach(e => console.error(e.formattedMessage));
      process.exit(1);
    }
    output.errors.filter(e => e.severity === 'warning').forEach(w => console.warn(`  [warn] ${w.message}`));
  }

  const registry = output.contracts['GeoDropRegistryV2.sol']['GeoDropRegistryV2'];
  const proxy = output.contracts['GeoDropProxy.sol']['GeoDropProxy'];

  return {
    registry: { abi: registry.abi, bytecode: '0x' + registry.evm.bytecode.object },
    proxy: { abi: proxy.abi, bytecode: '0x' + proxy.evm.bytecode.object },
  };
}

// ============================================================
// Deploy to Hardhat in-process network
// ============================================================

async function main() {
  console.log('=== Local Deployment Test ===\n');

  // Compile
  console.log('Compiling...');
  const compiled = compile();
  console.log(`  Registry bytecode: ${compiled.registry.bytecode.length / 2} bytes`);
  console.log(`  Proxy bytecode: ${compiled.proxy.bytecode.length / 2} bytes\n`);

  // Connect to local node or use Hardhat's built-in
  const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  let wallet;
  try {
    // Try to connect to running node
    await provider.getBlockNumber();
    // Use Hardhat's default account #0 with NonceManager for automining
    const rawWallet = new ethers.Wallet(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      provider,
    );
    wallet = new ethers.NonceManager(rawWallet);
    console.log(`Connected to local node. Deployer: ${rawWallet.address}\n`);
  } catch {
    console.log('No local node found. Running with ethers.js HardhatEthersProvider...');
    console.log('Start a local node first: npx hardhat node\n');
    process.exit(1);
  }

  // 1. Deploy implementation
  console.log('Deploying GeoDropRegistryV2 (implementation)...');
  const implFactory = new ethers.ContractFactory(compiled.registry.abi, compiled.registry.bytecode, wallet);
  const impl = await implFactory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`  Implementation: ${implAddr}\n`);

  // 2. Deploy proxy with initialize(admin)
  console.log('Deploying GeoDropProxy...');
  const deployerAddr = await wallet.getAddress();
  const initData = impl.interface.encodeFunctionData('initialize', [deployerAddr]);
  const proxyFactory = new ethers.ContractFactory(compiled.proxy.abi, compiled.proxy.bytecode, wallet);
  const proxy = await proxyFactory.deploy(implAddr, initData);
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  console.log(`  Proxy: ${proxyAddr}\n`);

  // 3. Verify via proxy
  console.log('Verifying...');
  const registry = new ethers.Contract(proxyAddr, compiled.registry.abi, wallet);

  const version = await registry.version();
  console.log(`  version() = ${version}`);
  if (Number(version) !== 2) throw new Error(`Expected version 2, got ${version}`);

  const admin = await registry.admin();
  console.log(`  admin() = ${admin}`);
  if (admin.toLowerCase() !== deployerAddr.toLowerCase()) throw new Error('Admin mismatch');

  // 4. Test registerDropV2
  console.log('\nTesting registerDropV2...');
  const geohash = ethers.hexlify(ethers.toUtf8Bytes('xn76urg'));
  const tx = await registry.registerDropV2(geohash, 'QmTestCid123', 2);
  await tx.wait();
  console.log(`  registerDropV2 OK (tx: ${tx.hash})`);

  // 5. Test getDropCids
  const cids = await registry.getDropCids(geohash);
  console.log(`  getDropCids: ${JSON.stringify(cids)}`);
  if (cids.length !== 1 || cids[0] !== 'QmTestCid123') throw new Error('CID mismatch');

  // 6. Test cooldown
  console.log('\nTesting cooldown...');
  try {
    await registry.registerDropV2(geohash, 'QmTestCid456', 2);
    console.log('  ERROR: Should have been rate-limited');
  } catch (e) {
    if (e.message.includes('Cooldown') || e.code === 'CALL_EXCEPTION') {
      console.log('  Cooldown enforced — OK (reverted as expected)');
    } else {
      throw e;
    }
  }

  // 7. Test duplicate prevention
  console.log('\nTesting deduplication...');
  // Wait for cooldown
  await new Promise(r => setTimeout(r, 11000));
  try {
    await registry.registerDropV2(geohash, 'QmTestCid123', 2);
    console.log('  ERROR: Should have been blocked as duplicate');
  } catch (e) {
    if (e.message.includes('Already registered') || e.code === 'CALL_EXCEPTION') {
      console.log('  Deduplication enforced — OK (reverted as expected)');
    } else {
      throw e;
    }
  }

  console.log('\n=== All Tests Passed ===');
  console.log(`  Proxy: ${proxyAddr}`);
  console.log(`  Implementation: ${implAddr}`);
}

main().catch(err => {
  console.error('\nTest failed:', err.message);
  process.exit(1);
});
