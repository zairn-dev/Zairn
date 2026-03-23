# GeoDropRegistryV2 Deployment Guide

## Overview

Deploys the UUPS-upgradeable GeoDropRegistryV2 contract via an ERC-1967 proxy.

**Deployment order:**

1. Compile `GeoDropRegistryV2.sol` and `GeoDropProxy.sol` (solc 0.8.20+)
2. Deploy `GeoDropRegistryV2` (implementation — no constructor args)
3. Deploy `GeoDropProxy(implementationAddress, initData)` where `initData` encodes `initialize(admin)`
4. Verify that `version()` returns `2` when called through the proxy
5. (Optional) Verify source on block explorer

## Supported Networks

| Network          | Chain ID | RPC                                          | Explorer                              |
|------------------|----------|----------------------------------------------|---------------------------------------|
| Base Sepolia     | 84532    | `https://sepolia.base.org`                   | https://sepolia.basescan.org          |
| Polygon Amoy     | 80002    | `https://rpc-amoy.polygon.technology`        | https://amoy.polygonscan.com          |
| Arbitrum Sepolia  | 421614   | `https://sepolia-rollup.arbitrum.io/rpc`     | https://sepolia.arbiscan.io           |

## Environment Variables

| Variable        | Required | Description                                              |
|-----------------|----------|----------------------------------------------------------|
| `RPC_URL`       | Yes      | JSON-RPC endpoint for the target network                 |
| `PRIVATE_KEY`   | Yes      | Deployer wallet private key (hex, with or without `0x`)  |
| `ADMIN_ADDRESS` | Yes      | Address that will be set as the proxy admin               |
| `CHAIN_NAME`    | No       | Label saved in the deployment output (default: `unknown`) |

## Quick Start

```bash
# 1. Copy and fill in environment variables
cp .env.example .env
# Edit .env with your values

# 2. Install solc (if not already available)
npm i -g solc    # or use solcjs / native solc

# 3. Compile contracts (the deploy script handles this automatically via solc JSON input)

# 4. Run the deployment
node deploy.mjs
```

The script outputs a JSON file at `deployments/<chain-name>-<timestamp>.json` containing:

- Implementation and proxy contract addresses
- Transaction hashes for both deployments
- The admin address used
- Chain ID and RPC URL
- Timestamp

## Post-Deployment Verification

After deployment, verify the contracts on the block explorer:

```bash
# Example for Base Sepolia (adjust explorer URL per network)
# Implementation
curl "https://api-sepolia.basescan.org/api?module=contract&action=verifysourcecode" \
  -d "contractaddress=<IMPL_ADDRESS>" \
  -d "sourceCode=<FLATTENED_SOURCE>" \
  -d "contractname=GeoDropRegistryV2" \
  -d "compilerversion=v0.8.20" \
  -d "optimizationUsed=1&runs=200"

# Proxy — verify as ERC-1967 proxy
curl "https://api-sepolia.basescan.org/api?module=contract&action=verifyproxycontract" \
  -d "address=<PROXY_ADDRESS>"
```

## Security Notes

- Never commit `.env` or private keys to version control.
- The admin address controls upgrades (24-hour timelock). Use a multisig in production.
- The deployer wallet only needs enough native token for gas (~0.001 ETH on L2 testnets).
- Faucets: [Base Sepolia](https://www.alchemy.com/faucets/base-sepolia), [Polygon Amoy](https://faucet.polygon.technology/), [Arbitrum Sepolia](https://www.alchemy.com/faucets/arbitrum-sepolia).
