// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title GeoDropProxy
 * @notice Minimal ERC-1967 proxy for GeoDropRegistryV2.
 *         All calls are delegated to the implementation contract.
 *         Upgrade is controlled by the implementation's `upgradeTo`.
 *
 * @dev Deploy sequence:
 *      1. Deploy GeoDropRegistryV2 (implementation)
 *      2. Deploy GeoDropProxy(implementationAddress, initData)
 *         where initData = abi.encodeCall(GeoDropRegistryV2.initialize, (adminAddress))
 *      3. All interactions go through the proxy address
 */
contract GeoDropProxy {
    /// @dev ERC-1967 implementation slot
    bytes32 private constant _IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    constructor(address implementation, bytes memory initData) {
        require(implementation.code.length > 0, "Not a contract");
        assembly {
            sstore(_IMPL_SLOT, implementation)
        }
        if (initData.length > 0) {
            (bool ok, ) = implementation.delegatecall(initData);
            require(ok, "Init failed");
        }
    }

    fallback() external payable {
        assembly {
            let impl := sload(_IMPL_SLOT)
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    // No receive() — reject accidental ETH transfers
}
