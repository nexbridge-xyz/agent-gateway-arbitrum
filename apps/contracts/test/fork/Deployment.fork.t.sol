// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MandateVault} from "../../src/MandateVault.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Checks the deployment recorded in `deployments/arbitrum-sepolia.json` against the live chain.
/// @dev Skipped unless ARBITRUM_SEPOLIA_RPC_URL is set. Run with `pnpm test:fork`.
contract DeploymentForkTest is Test {
    using stdJson for string;

    string internal record;
    MandateVault internal vault;
    bool internal forked;

    function setUp() public {
        string memory rpcUrl = vm.envOr("ARBITRUM_SEPOLIA_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return;
        vm.createSelectFork(rpcUrl);
        forked = true;

        record = vm.readFile("deployments/arbitrum-sepolia.json");
        vault = MandateVault(record.readAddress(".contracts.MandateVault.address"));
    }

    modifier onlyOnFork() {
        if (!forked) {
            vm.skip(true, "Set ARBITRUM_SEPOLIA_RPC_URL to run fork tests");
        }
        _;
    }

    function test_Fork_RecordedVaultIsLiveAndWiredAsRecorded() public onlyOnFork {
        assertEq(record.readUint(".chainId"), block.chainid);
        assertGt(address(vault).code.length, 0);
        assertEq(vault.principal(), record.readAddress(".principal"));
        assertEq(address(vault.token()), record.readAddress(".token"));
        assertEq(address(vault.identityRegistry()), record.readAddress(".identityRegistry"));

        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            vault.eip712Domain();
        assertEq(name, "MandateVault");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(vault));
    }

    /// The code at the recorded address is exactly what this repository builds: running the constructor
    /// again at the same address, with the recorded arguments, gives byte-identical code.
    function test_Fork_LiveCodeMatchesThisRepository() public onlyOnFork {
        bytes32 liveCodeHash = address(vault).codehash;

        deployCodeTo(
            "MandateVault.sol:MandateVault",
            abi.encode(
                record.readAddress(".token"), record.readAddress(".principal"), record.readAddress(".identityRegistry")
            ),
            address(vault)
        );

        assertEq(address(vault).codehash, liveCodeHash);
    }
}
