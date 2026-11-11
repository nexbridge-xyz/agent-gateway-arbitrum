// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Minimal ERC-1271 smart account with a single owner key, standing in for a Safe-style approver.
contract MockSmartAccount is IERC1271 {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function setOwner(address newOwner) external {
        owner = newOwner;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == owner) {
            return IERC1271.isValidSignature.selector;
        }
        return 0xffffffff;
    }
}
