// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title GeoDropRegistryV2
 * @notice Upgradeable (UUPS) append-only registry mapping geohash → IPFS metadata CIDs.
 *         Supports multi-precision geohash indexing and metadata format versioning.
 *
 * @dev Upgrade path: V1 (immutable) → V2 (UUPS proxy).
 *      V1 data is NOT migrated automatically; V1 contract remains readable.
 *      New registrations go through V2. Clients query both during transition.
 *
 *      Storage layout is append-only: upgrades MUST NOT reorder existing slots.
 *      Uses ERC-1967 proxy standard for transparent upgradeability.
 *
 * Gas cost per registration: ~50,000-70,000 gas (slightly higher than V1 due to proxy).
 * On L2s (Base, Polygon, Arbitrum) this is well under $0.01.
 */

// ============================================================
// Minimal UUPS implementation (no OpenZeppelin dependency)
// ============================================================

/// @dev ERC-1967 implementation slot
bytes32 constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

/// @dev ERC-1967 admin slot (used for upgrade authorization)
bytes32 constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

contract GeoDropRegistryV2 {
    // ============================================================
    // Events
    // ============================================================

    event DropRegistered(
        bytes7 indexed geohash,
        string metadataCid,
        address indexed sender,
        uint256 timestamp,
        uint8 metadataVersion
    );

    event DropRegisteredMultiPrecision(
        bytes7 indexed geohash7,
        bytes5 indexed geohash5,
        string metadataCid,
        address indexed sender
    );

    event Upgraded(address indexed implementation);
    event UpgradeProposed(address indexed implementation, uint256 executeAfter);
    event Initialized(address indexed admin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    // ============================================================
    // Storage layout (append-only — NEVER reorder or remove slots)
    //
    // Slot 0: mapping(bytes7 => string[])   _cidsByGeohash          [V1]
    // Slot 1: mapping(bytes32 => bool)      _registered              [V1]
    // Slot 2: mapping(bytes5 => string[])   _cidsByGeohash5          [V2]
    // Slot 3: mapping(bytes32 => uint8)     _metadataVersion         [V2]
    // Slot 4: bool                          _initialized             [V2]
    // Slot 5: mapping(address => uint256)   _lastRegistration        [V2]
    // Slot 6: address                       _proposedImplementation  [V2]
    // Slot 7: uint256                       _upgradeProposedAt       [V2]
    //
    // WARNING: Future upgrades MUST append new state variables
    //          AFTER slot 7. Never insert between existing slots.
    // ============================================================

    /// @dev Slot 0 — V1-compatible: geohash (precision-7) → array of IPFS metadata CIDs
    mapping(bytes7 => string[]) private _cidsByGeohash;

    /// @dev Slot 1 — V1-compatible: deduplication guard
    mapping(bytes32 => bool) private _registered;

    /// @dev Slot 2 — V2: multi-precision index (precision-5 for broader search)
    mapping(bytes5 => string[]) private _cidsByGeohash5;

    /// @dev Slot 3 — V2: metadata version per CID (default 0 = V1 format)
    mapping(bytes32 => uint8) private _metadataVersion;

    /// @dev Slot 4 — V2: initialized flag (prevents re-initialization after upgrade)
    bool private _initialized;

    /// @dev Slot 5 — V2: per-address cooldown for anti-spam
    mapping(address => uint256) private _lastRegistration;

    /// @dev Slot 6 — V2: upgrade timelock
    address private _proposedImplementation;
    uint256 private _upgradeProposedAt;

    /// @dev Minimum cooldown between registrations per address (seconds)
    uint256 private constant REGISTRATION_COOLDOWN = 10;
    /// @dev Upgrade timelock delay (seconds)
    uint256 private constant UPGRADE_DELAY = 86400; // 24 hours

    // ============================================================
    // Initialization (replaces constructor for proxy pattern)
    // ============================================================

    function initialize(address admin_) external {
        require(!_initialized, "Already initialized");
        _initialized = true;
        _setAdmin(admin_);
        emit Initialized(admin_);
    }

    // ============================================================
    // Admin / Upgrade
    // ============================================================

    modifier onlyAdmin() {
        require(msg.sender == _getAdmin(), "Not admin");
        _;
    }

    function admin() external view returns (address) {
        return _getAdmin();
    }

    /// @notice Transfer admin role (for key rotation / multisig migration)
    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "Zero address");
        address prev = _getAdmin();
        _setAdmin(newAdmin);
        emit AdminTransferred(prev, newAdmin);
    }

    /// @notice Propose a new implementation (starts timelock)
    function proposeUpgrade(address newImplementation) external onlyAdmin {
        require(newImplementation.code.length > 0, "Not a contract");
        _proposedImplementation = newImplementation;
        _upgradeProposedAt = block.timestamp;
        emit UpgradeProposed(newImplementation, block.timestamp + UPGRADE_DELAY);
    }

    /// @notice Execute upgrade after timelock expires
    function executeUpgrade() external onlyAdmin {
        require(_proposedImplementation != address(0), "No upgrade proposed");
        require(block.timestamp >= _upgradeProposedAt + UPGRADE_DELAY, "Timelock not expired");
        address impl = _proposedImplementation;
        _proposedImplementation = address(0);
        _upgradeProposedAt = 0;
        assembly {
            sstore(IMPLEMENTATION_SLOT, impl)
        }
        emit Upgraded(impl);
    }

    /// @notice Cancel a pending upgrade
    function cancelUpgrade() external onlyAdmin {
        _proposedImplementation = address(0);
        _upgradeProposedAt = 0;
    }

    function _getAdmin() internal view returns (address a) {
        assembly {
            a := sload(ADMIN_SLOT)
        }
    }

    function _setAdmin(address a) internal {
        assembly {
            sstore(ADMIN_SLOT, a)
        }
    }

    // ============================================================
    // Registration (V2: multi-precision + metadata version)
    // ============================================================

    /// @notice Register a drop with metadata version and multi-precision indexing
    /// @param geohash7 7-byte geohash (precision 7, ~153m × 153m)
    /// @param metadataCid IPFS CID of the DropMetadataDocument
    /// @param metadataVer Metadata document version (1 = V1, 2 = V2 with encryption versioning)
    function registerDropV2(
        bytes7 geohash7,
        string calldata metadataCid,
        uint8 metadataVer
    ) external {
        require(
            block.timestamp >= _lastRegistration[msg.sender] + REGISTRATION_COOLDOWN,
            "Cooldown: wait before registering again"
        );
        bytes32 key = keccak256(abi.encodePacked(geohash7, metadataCid));
        require(!_registered[key], "Already registered");

        _registered[key] = true;
        _cidsByGeohash[geohash7].push(metadataCid);
        _metadataVersion[key] = metadataVer;

        // Also index at precision 5 (~4.9km × 4.9km) for broader search
        bytes5 geohash5 = bytes5(geohash7);
        bytes32 key5 = keccak256(abi.encodePacked(geohash5, metadataCid));
        if (!_registered[key5]) {
            _registered[key5] = true;
            _cidsByGeohash5[geohash5].push(metadataCid);
        }

        _lastRegistration[msg.sender] = block.timestamp;

        emit DropRegistered(geohash7, metadataCid, msg.sender, block.timestamp, metadataVer);
        emit DropRegisteredMultiPrecision(geohash7, geohash5, metadataCid, msg.sender);
    }

    /// @notice V1-compatible registration (metadata version defaults to 1)
    function registerDrop(bytes7 geohash, string calldata metadataCid) external {
        require(
            block.timestamp >= _lastRegistration[msg.sender] + REGISTRATION_COOLDOWN,
            "Cooldown: wait before registering again"
        );
        bytes32 key = keccak256(abi.encodePacked(geohash, metadataCid));
        require(!_registered[key], "Already registered");

        _registered[key] = true;
        _cidsByGeohash[geohash].push(metadataCid);
        _lastRegistration[msg.sender] = block.timestamp;

        emit DropRegistered(geohash, metadataCid, msg.sender, block.timestamp, 1);
    }

    // ============================================================
    // Query (V1-compatible + V2 multi-precision)
    // ============================================================

    function getDropCids(bytes7 geohash) external view returns (string[] memory) {
        return _cidsByGeohash[geohash];
    }

    function getDropCidsByPrecision5(bytes5 geohash5) external view returns (string[] memory) {
        return _cidsByGeohash5[geohash5];
    }

    function getDropCount(bytes7 geohash) external view returns (uint256) {
        return _cidsByGeohash[geohash].length;
    }

    function getMetadataVersion(bytes7 geohash, string calldata metadataCid) external view returns (uint8) {
        bytes32 key = keccak256(abi.encodePacked(geohash, metadataCid));
        return _metadataVersion[key];
    }

    function getDropCidsPaginated(
        bytes7 geohash,
        uint256 offset,
        uint256 limit
    ) external view returns (string[] memory cids) {
        string[] storage all = _cidsByGeohash[geohash];
        if (offset >= all.length) return new string[](0);
        uint256 end = offset + limit;
        if (end > all.length) end = all.length;
        uint256 size = end - offset;
        cids = new string[](size);
        for (uint256 i = 0; i < size; i++) {
            cids[i] = all[offset + i];
        }
    }

    /// @notice Contract version for client compatibility checks
    function version() external pure returns (uint8) {
        return 2;
    }
}
