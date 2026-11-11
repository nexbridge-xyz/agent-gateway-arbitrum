// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice Test stand-in for the ERC-8004 Identity Registry: an ERC-721 where `register` mints the next
/// agent id to the caller. Like the real registry, `ownerOf` reverts for an id that was never registered.
contract MockIdentityRegistry is ERC721 {
    uint256 private _lastId;

    constructor() ERC721("AgentIdentity", "AGENT") {}

    function register() external returns (uint256 agentId) {
        agentId = ++_lastId;
        _mint(msg.sender, agentId);
    }
}
