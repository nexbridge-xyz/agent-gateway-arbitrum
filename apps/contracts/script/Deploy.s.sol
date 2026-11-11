// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MandateVault} from "../src/MandateVault.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Deploys MandateVault to Arbitrum Sepolia.
/// @dev Reads from the environment:
///  - DEPLOYER_PRIVATE_KEY: pays for the deployment. Holds no role in the vault.
///  - PRINCIPAL_ADDRESS: the owner of the vault and its funds.
///  - USDC_ADDRESS, IDENTITY_REGISTRY_ADDRESS: optional overrides of the Arbitrum Sepolia defaults.
contract Deploy is Script {
    uint256 internal constant ARBITRUM_SEPOLIA_CHAIN_ID = 421_614;
    address internal constant USDC_ARBITRUM_SEPOLIA = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;
    address internal constant IDENTITY_REGISTRY_ARBITRUM_SEPOLIA = 0x8004A818BFB912233c491871b3d84c89A494BD9e;

    error TestnetOnly(uint256 chainId);
    error NotAContract(string name, address target);

    function run() external returns (MandateVault vault) {
        // This script is for the testnet. A mainnet deployment is a separate, deliberate step.
        if (block.chainid != ARBITRUM_SEPOLIA_CHAIN_ID) revert TestnetOnly(block.chainid);

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address principal = vm.envAddress("PRINCIPAL_ADDRESS");
        address usdc = vm.envOr("USDC_ADDRESS", USDC_ARBITRUM_SEPOLIA);
        address registry = vm.envOr("IDENTITY_REGISTRY_ADDRESS", IDENTITY_REGISTRY_ARBITRUM_SEPOLIA);
        if (usdc.code.length == 0) revert NotAContract("USDC_ADDRESS", usdc);
        if (registry.code.length == 0) revert NotAContract("IDENTITY_REGISTRY_ADDRESS", registry);

        vm.startBroadcast(deployerKey);
        vault = new MandateVault(IERC20(usdc), principal, IIdentityRegistry(registry));
        vm.stopBroadcast();

        console2.log("MandateVault:      ", address(vault));
        console2.log("principal:         ", vault.principal());
        console2.log("token (USDC):      ", address(vault.token()));
        console2.log("identity registry: ", address(vault.identityRegistry()));
    }
}
