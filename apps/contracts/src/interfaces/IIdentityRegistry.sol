// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IIdentityRegistry
/// @notice The part of the ERC-8004 Identity Registry that MandateVault reads.
/// @dev The registry is an ERC-721. An agent's id is its token id, and `ownerOf` reverts for an id that was
/// never registered.
interface IIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
}
