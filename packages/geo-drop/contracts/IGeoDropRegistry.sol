// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IGeoDropRegistry
 * @notice GeoDrop Protocol のオンチェーンレジストリインターフェース
 *         異なる実装間の相互運用性を保証するための最小インターフェース定義
 *
 * @dev 全ての準拠実装はこのインターフェースを満たす必要がある。
 *      See: protocol/SPEC.md §4
 */
interface IGeoDropRegistry {
    /// @notice 新しいドロップメタデータCIDが登録された時に発行
    /// @param geohash 7バイトのgeohash (precision 7)
    /// @param metadataCid IPFS上のDropMetadataDocumentのCID
    /// @param sender 登録者のアドレス
    /// @param timestamp 登録時のブロックタイムスタンプ
    event DropRegistered(
        bytes7 indexed geohash,
        string metadataCid,
        address indexed sender,
        uint256 timestamp
    );

    /// @notice メタデータCIDをgeohashに登録する
    /// @dev Append-only。同一ペアの二重登録は revert する。
    /// @param geohash 7バイトのgeohash (precision 7)
    /// @param metadataCid IPFS上のDropMetadataDocumentのCID
    function registerDrop(bytes7 geohash, string calldata metadataCid) external;

    /// @notice geohashに登録された全メタデータCIDを取得する
    /// @param geohash 7バイトのgeohash (precision 7)
    /// @return cids メタデータCIDの配列
    function getDropCids(bytes7 geohash) external view returns (string[] memory cids);

    /// @notice geohashに登録されたドロップ数を取得する
    /// @param geohash 7バイトのgeohash (precision 7)
    /// @return count 登録数
    function getDropCount(bytes7 geohash) external view returns (uint256 count);

    /// @notice ページネーション付きでメタデータCIDを取得する
    /// @param geohash 7バイトのgeohash (precision 7)
    /// @param offset 開始インデックス
    /// @param limit 最大取得数
    /// @return cids メタデータCIDの配列
    function getDropCidsPaginated(
        bytes7 geohash,
        uint256 offset,
        uint256 limit
    ) external view returns (string[] memory cids);
}
