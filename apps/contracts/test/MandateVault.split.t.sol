// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MandateVault} from "../src/MandateVault.sol";
import {MandateVaultBase} from "./MandateVaultBase.sol";

/// @notice The demo's layout: one mandate for vendor invoices, and a small one that only funds the
/// gateway's spend wallet. These tests state what a stolen executor key can do with it:
/// at most 1 USDC a day reaches the spend wallet, and everything else can only go to listed vendors.
contract MandateVaultSplitTest is MandateVaultBase {
    uint256 internal constant SPEND_PER_PAYMENT_CAP = USDC / 2;
    uint256 internal constant SPEND_DAILY_CAP = 1 * USDC;
    uint256 internal constant SPEND_HARD_CEILING = 1 * USDC;

    uint256 internal vendorMandateId;
    uint256 internal spendMandateId;
    uint256 internal executorKey;

    function setUp() public override {
        super.setUp();
        // The same address as `executor`, with its key, so that a test can sign as the executor.
        (, executorKey) = makeAddrAndKey("executor");

        // The shared fixture lists the spend wallet next to the vendors. Replace it with the two mandates.
        vm.prank(principal);
        vault.revokeMandate(mandateId);

        Terms memory vendors = _terms();
        vendors.payees = new address[](2);
        vendors.payees[0] = vendorA;
        vendors.payees[1] = vendorB;
        vendorMandateId = _create(vendors);

        Terms memory spend = _terms();
        spend.payees = new address[](1);
        spend.payees[0] = spendWallet;
        spend.perPaymentCap = SPEND_PER_PAYMENT_CAP;
        spend.dailyCap = SPEND_DAILY_CAP;
        spend.hardCeiling = SPEND_HARD_CEILING;
        spend.termsHash = keccak256("Demo mandate v1: spend wallet");
        spendMandateId = _create(spend);
    }

    function _payAs(uint256 id, address payee, uint256 amount) internal {
        bytes32 evidenceHash = _evidence();
        vm.prank(executor);
        vault.payWithinMandate(id, payee, amount, evidenceHash);
    }

    // ------------------------------------------------------------------------------------------------------
    // What the two mandates allow
    // ------------------------------------------------------------------------------------------------------

    function test_TwoMandates_OneAgentHoldsBoth() public view {
        assertTrue(vault.isActive(vendorMandateId));
        assertTrue(vault.isActive(spendMandateId));
        assertEq(vault.getMandate(vendorMandateId).agentId, agentId);
        assertEq(vault.getMandate(spendMandateId).agentId, agentId);
        assertFalse(vault.isAllowedPayee(vendorMandateId, spendWallet));
        assertTrue(vault.isAllowedPayee(spendMandateId, spendWallet));
        assertFalse(vault.isAllowedPayee(spendMandateId, vendorA));
    }

    function test_TwoMandates_EachCountsItsOwnDay() public {
        _payAs(vendorMandateId, vendorA, 2 * USDC);
        _payAs(spendMandateId, spendWallet, USDC / 10);

        assertEq(vault.spentToday(vendorMandateId), 2 * USDC);
        assertEq(vault.spentToday(spendMandateId), USDC / 10);
    }

    // ------------------------------------------------------------------------------------------------------
    // A stolen executor key
    // ------------------------------------------------------------------------------------------------------

    function test_StolenExecutorKey_MovesAtMostOneUsdcADayToTheSpendWallet() public {
        _payAs(spendMandateId, spendWallet, SPEND_PER_PAYMENT_CAP);
        _payAs(spendMandateId, spendWallet, SPEND_PER_PAYMENT_CAP);

        // Not one unit more today.
        bytes32 evidenceHash = _evidence();
        vm.expectRevert(
            abi.encodeWithSelector(MandateVault.DailyCapExceeded.selector, SPEND_DAILY_CAP + 1, SPEND_DAILY_CAP)
        );
        vm.prank(executor);
        vault.payWithinMandate(spendMandateId, spendWallet, 1, evidenceHash);
        assertEq(usdc.balanceOf(spendWallet), 1 * USDC);

        // The next UTC day allows the same again, and no more.
        vm.warp(_now() + 1 days);
        _payAs(spendMandateId, spendWallet, SPEND_PER_PAYMENT_CAP);
        _payAs(spendMandateId, spendWallet, SPEND_PER_PAYMENT_CAP);
        evidenceHash = _evidence();
        vm.expectRevert(
            abi.encodeWithSelector(MandateVault.DailyCapExceeded.selector, SPEND_DAILY_CAP + 1, SPEND_DAILY_CAP)
        );
        vm.prank(executor);
        vault.payWithinMandate(spendMandateId, spendWallet, 1, evidenceHash);
        assertEq(usdc.balanceOf(spendWallet), 2 * USDC);
    }

    function test_StolenExecutorKey_RevertWhen_OnePaymentToTheSpendWalletIsOverItsCap() public {
        bytes32 evidenceHash = _evidence();
        vm.expectRevert(
            abi.encodeWithSelector(
                MandateVault.PerPaymentCapExceeded.selector, SPEND_PER_PAYMENT_CAP + 1, SPEND_PER_PAYMENT_CAP
            )
        );
        vm.prank(executor);
        vault.payWithinMandate(spendMandateId, spendWallet, SPEND_PER_PAYMENT_CAP + 1, evidenceHash);
    }

    function test_StolenExecutorKey_RevertWhen_TheSpendWalletIsPaidFromTheVendorMandate() public {
        bytes32 evidenceHash = _evidence();
        vm.expectRevert(abi.encodeWithSelector(MandateVault.PayeeNotAllowed.selector, vendorMandateId, spendWallet));
        vm.prank(executor);
        vault.payWithinMandate(vendorMandateId, spendWallet, USDC / 10, evidenceHash);
    }

    function test_StolenExecutorKey_RevertWhen_PayingAnAddressOnNeitherList() public {
        bytes32 evidenceHash = _evidence();
        vm.expectRevert(abi.encodeWithSelector(MandateVault.PayeeNotAllowed.selector, vendorMandateId, attacker));
        vm.prank(executor);
        vault.payWithinMandate(vendorMandateId, attacker, 1, evidenceHash);

        vm.expectRevert(abi.encodeWithSelector(MandateVault.PayeeNotAllowed.selector, spendMandateId, attacker));
        vm.prank(executor);
        vault.payWithinMandate(spendMandateId, attacker, 1, evidenceHash);
    }

    function test_StolenExecutorKey_RevertWhen_ItSignsItsOwnApproval() public {
        uint256 deadline = _now() + 1 hours;
        uint256[2] memory ids = [vendorMandateId, spendMandateId];
        for (uint256 i = 0; i < ids.length; ++i) {
            bytes32 evidenceHash = _evidence();
            bytes memory signature = _signApproval(executorKey, ids[i], attacker, USDC / 2, evidenceHash, 0, deadline);
            vm.expectRevert(MandateVault.InvalidApproval.selector);
            vm.prank(executor);
            vault.payWithApproval(ids[i], attacker, USDC / 2, evidenceHash, deadline, signature);
        }
        assertEq(usdc.balanceOf(attacker), 0);
    }

    /// @dev Whatever the executor key tries within one day, on either mandate, to any address:
    /// the spend wallet ends with at most 1 USDC, the vendors with at most the vendor mandate's daily
    /// cap, and nobody else with anything.
    function testFuzz_StolenExecutorKey_IsBoundedByTheTwoMandates(
        uint256[12] memory amounts,
        uint8[12] memory payeeChoices,
        bool[12] memory useSpendMandate
    ) public {
        address[5] memory targets = [spendWallet, vendorA, vendorB, attacker, unlistedVendor];
        uint256 vaultBefore = usdc.balanceOf(address(vault));

        for (uint256 i = 0; i < amounts.length; ++i) {
            address payee = targets[payeeChoices[i] % targets.length];
            uint256 amount = bound(amounts[i], 0, 30 * USDC);
            uint256 id = useSpendMandate[i] ? spendMandateId : vendorMandateId;
            bytes32 evidenceHash = _evidence();
            vm.prank(executor);
            try vault.payWithinMandate(id, payee, amount, evidenceHash) {} catch {}
        }

        uint256 toSpendWallet = usdc.balanceOf(spendWallet);
        uint256 toVendors = usdc.balanceOf(vendorA) + usdc.balanceOf(vendorB);
        assertLe(toSpendWallet, SPEND_DAILY_CAP, "the spend wallet received more than its daily cap");
        assertLe(toVendors, DAILY_CAP, "the vendors received more than the vendor mandate's daily cap");
        assertEq(usdc.balanceOf(attacker), 0, "the attacker received funds");
        assertEq(usdc.balanceOf(unlistedVendor), 0, "an unlisted address received funds");
        assertEq(vaultBefore - usdc.balanceOf(address(vault)), toSpendWallet + toVendors, "funds went elsewhere");
    }
}
