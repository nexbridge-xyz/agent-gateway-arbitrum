// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MandateVault} from "../../src/MandateVault.sol";
import {IIdentityRegistry} from "../../src/interfaces/IIdentityRegistry.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Test} from "forge-std/Test.sol";

/// @dev The ERC-8004 Identity Registry functions this test uses.
interface IERC8004IdentityRegistry is IIdentityRegistry {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function getAgentWallet(uint256 agentId) external view returns (address);
}

/// @notice Runs the demo's onchain steps on a fork of Arbitrum Sepolia, against Circle's test USDC and the
/// live ERC-8004 Identity Registry.
/// @dev Skipped unless ARBITRUM_SEPOLIA_RPC_URL is set. Run with `pnpm test:fork`.
contract MandateVaultForkTest is Test {
    uint256 internal constant ARBITRUM_SEPOLIA_CHAIN_ID = 421_614;
    address internal constant USDC_ADDRESS = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;
    address internal constant IDENTITY_REGISTRY_ADDRESS = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    uint256 internal constant USDC = 1e6;

    IERC20Metadata internal usdc = IERC20Metadata(USDC_ADDRESS);
    IERC8004IdentityRegistry internal registry = IERC8004IdentityRegistry(IDENTITY_REGISTRY_ADDRESS);
    MandateVault internal vault;

    address internal principal = makeAddr("principal");
    address internal executor = makeAddr("executor");
    address internal approver;
    uint256 internal approverKey;
    address internal agentWallet = makeAddr("agentWallet");
    address internal spendWallet = makeAddr("spendWallet");
    address internal vendorA = makeAddr("vendorA");
    address internal vendorB = makeAddr("vendorB");
    address internal attacker = makeAddr("attacker");

    bool internal forked;
    uint256 internal agentId;
    uint256 internal mandateId;

    function setUp() public {
        string memory rpcUrl = vm.envOr("ARBITRUM_SEPOLIA_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return;
        vm.createSelectFork(rpcUrl);
        forked = true;
        (approver, approverKey) = makeAddrAndKey("approver");

        vault = new MandateVault(usdc, principal, registry);

        // Step 1 of the demo: register the agent, fund the vault, create the mandate.
        vm.prank(agentWallet);
        agentId = registry.register("https://example.com/agents/research-and-procurement.json");

        deal(USDC_ADDRESS, principal, 20 * USDC);
        address[] memory payees = new address[](3);
        payees[0] = spendWallet;
        payees[1] = vendorA;
        payees[2] = vendorB;

        vm.startPrank(principal);
        usdc.approve(address(vault), 20 * USDC);
        vault.deposit(20 * USDC);
        mandateId = vault.createMandate(
            agentId,
            executor,
            approver,
            payees,
            2 * USDC,
            8 * USDC,
            20 * USDC,
            uint64(vm.getBlockTimestamp() + 30 days),
            keccak256("Demo mandate v1")
        );
        vm.stopPrank();
    }

    modifier onlyOnFork() {
        if (!forked) {
            vm.skip(true, "Set ARBITRUM_SEPOLIA_RPC_URL to run fork tests");
        }
        _;
    }

    function test_Fork_UsesTheLiveUsdcAndRegistry() public onlyOnFork {
        assertEq(block.chainid, ARBITRUM_SEPOLIA_CHAIN_ID);
        assertEq(usdc.symbol(), "USDC");
        assertEq(usdc.decimals(), 6);
        assertEq(registry.ownerOf(agentId), agentWallet);
        // A newly registered agent's wallet is its owner until the owner sets another one.
        assertEq(registry.getAgentWallet(agentId), agentWallet);
        assertEq(usdc.balanceOf(address(vault)), 20 * USDC);
    }

    function test_Fork_DemoPath() public onlyOnFork {
        // Step 2: top up the spend wallet that pays per-call API charges.
        vm.prank(executor);
        vault.payWithinMandate(mandateId, spendWallet, 100_000, keccak256("evidence: spend wallet top-up"));
        assertEq(usdc.balanceOf(spendWallet), 100_000);

        // Step 3: pay a known vendor 1.50 USDC inside the mandate.
        vm.prank(executor);
        vault.payWithinMandate(mandateId, vendorA, 1_500_000, keccak256("evidence: vendor invoice"));
        assertEq(usdc.balanceOf(vendorA), 1_500_000);

        // Step 4: a 6 USDC invoice is above the 2 USDC per-payment cap and needs the approver.
        vm.expectRevert(abi.encodeWithSelector(MandateVault.PerPaymentCapExceeded.selector, 6 * USDC, 2 * USDC));
        vm.prank(executor);
        vault.payWithinMandate(mandateId, vendorB, 6 * USDC, keccak256("evidence: large invoice"));

        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes32 evidenceHash = keccak256("evidence: large invoice");
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(approverKey, vault.approvalDigest(mandateId, vendorB, 6 * USDC, evidenceHash, 0, deadline));
        vm.prank(executor);
        vault.payWithApproval(mandateId, vendorB, 6 * USDC, evidenceHash, deadline, abi.encodePacked(r, s, v));
        assertEq(usdc.balanceOf(vendorB), 6 * USDC);

        // Step 6: the "gateway compromised" drill. The executor key alone cannot pay the attacker.
        vm.expectRevert(abi.encodeWithSelector(MandateVault.PayeeNotAllowed.selector, mandateId, attacker));
        vm.prank(executor);
        vault.payWithinMandate(mandateId, attacker, 9 * USDC, keccak256("evidence: drill"));
        assertEq(usdc.balanceOf(attacker), 0);

        // Step 7: the principal revokes the mandate and the next payment is refused.
        vm.prank(principal);
        vault.revokeMandate(mandateId);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.MandateIsRevoked.selector, mandateId));
        vm.prank(executor);
        vault.payWithinMandate(mandateId, vendorA, 1 * USDC, keccak256("evidence: after revoke"));

        // 20 - 0.10 - 1.50 - 6.00 = 12.40 USDC stays in the vault and goes back to the principal.
        assertEq(usdc.balanceOf(address(vault)), 12_400_000);
        vm.prank(principal);
        vault.withdraw(12_400_000);
        assertEq(usdc.balanceOf(principal), 12_400_000);
    }

    function test_Fork_RejectsAnAgentThatIsNotRegistered() public onlyOnFork {
        address[] memory payees = new address[](0);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.UnknownAgent.selector, type(uint256).max));
        vm.prank(principal);
        vault.createMandate(
            type(uint256).max,
            executor,
            approver,
            payees,
            2 * USDC,
            8 * USDC,
            20 * USDC,
            uint64(vm.getBlockTimestamp() + 30 days),
            keccak256("Demo mandate v1")
        );
    }
}
