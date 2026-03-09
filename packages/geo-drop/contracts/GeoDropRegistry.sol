// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title GeoDropRegistry
 * @notice Append-only registry mapping geohash → IPFS metadata CIDs.
 *         Enables DB-independent discovery and recovery of geo-drops.
 *         No owner, no access control, no upgradability — pure public good.
 *
 * @dev Gas cost per registration: ~45,000-65,000 gas.
 *      On L2s (Base, Polygon, Arbitrum) this is well under $0.01.
 */
contract GeoDropRegistry {
    /// @notice Emitted when a new drop metadata CID is registered
    event DropRegistered(
        bytes7 indexed geohash,
        string metadataCid,
        address indexed sender,
        uint256 timestamp
    );

    /// @dev geohash (7 bytes, precision-7) → array of IPFS metadata CIDs
    mapping(bytes7 => string[]) private _cidsByGeohash;

    /// @dev Deduplication guard: keccak256(geohash, metadataCid) → registered
    mapping(bytes32 => bool) private _registered;

    /// @notice Register a drop's metadata CID under a geohash
    /// @param geohash 7-byte geohash (precision 7)
    /// @param metadataCid IPFS CID of the DropMetadataDocument
    function registerDrop(bytes7 geohash, string calldata metadataCid) external {
        bytes32 key = keccak256(abi.encodePacked(geohash, metadataCid));
        require(!_registered[key], "Already registered");

        _registered[key] = true;
        _cidsByGeohash[geohash].push(metadataCid);

        emit DropRegistered(geohash, metadataCid, msg.sender, block.timestamp);
    }

    /// @notice Get all metadata CIDs for a geohash (free read, no gas)
    /// @param geohash 7-byte geohash (precision 7)
    /// @return cids Array of IPFS metadata CID strings
    function getDropCids(bytes7 geohash) external view returns (string[] memory cids) {
        return _cidsByGeohash[geohash];
    }

    /// @notice Get the number of drops registered at a geohash
    /// @param geohash 7-byte geohash (precision 7)
    /// @return count Number of registered CIDs
    function getDropCount(bytes7 geohash) external view returns (uint256 count) {
        return _cidsByGeohash[geohash].length;
    }

    /// @notice Paginated retrieval for geohashes with many drops
    /// @param geohash 7-byte geohash (precision 7)
    /// @param offset Starting index
    /// @param limit Maximum number of CIDs to return
    /// @return cids Array of IPFS metadata CID strings
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
}
