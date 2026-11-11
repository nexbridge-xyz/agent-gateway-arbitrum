// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MandateVault} from "../src/MandateVault.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {MandateVaultBase} from "./MandateVaultBase.sol";
import {MockSmartAccount} from "./mocks/MockSmartAccount.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @dev A registry that answers `ownerOf` with the zero address instead of reverting.
contract ZeroOwnerRegistry is IIdentityRegistry {
    function ownerOf(uint256) external pure returns (address) {
        return address(0);
    }
}

contract MandateVaultTest is MandateVaultBase {
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    // ------------------------------------------------------------------------------------------------------
    // Construction
    // ------------------------------------------------------------------------------------------------------

    function test_Constructor_SetsImmutables() public view {
        assertEq(address(vault.token()), address(usdc));
        assertEq(vault.principal(), principal);
        assertEq(address(vault.identityRegistry()), address(registry));
        assertEq(vault.mandateCount(), 1);
        assertFalse(vault.paused());
    }

    function test_Constructor_RevertWhen_AnAddressIsZero() public {
        IIdentityRegistry reg = IIdentityRegistry(address(registry));

        vm.expectRevert(MandateVault.ZeroAddress.selector);
        new MandateVault(IERC20(address(0)), principal, reg);

        vm.expectRevert(MandateVault.ZeroAddress.selector);
        new MandateVault(usdc, address(0), reg);

        vm.expectRevert(MandateVault.ZeroAddress.selector);
        new MandateVault(usdc, principal, IIdentityRegistry(address(0)));
    }

    function test_Eip712Domain_NamesThisVaultAndChain() public view {
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            vault.eip712Domain();
        assertEq(name, "MandateVault");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(vault));
    }

    // ------------------------------------------------------------------------------------------------------
    // Deposit and withdraw
    // ------------------------------------------------------------------------------------------------------

    function test_Deposit_MovesFundsIntoVault() public {
        vm.expectEmit(address(vault));
        emit MandateVault.Deposited(principal, 5 * USDC);
        vm.prank(principal);
        vault.deposit(5 * USDC);

        assertEq(usdc.balanceOf(address(vault)), VAULT_FUNDS + 5 * USDC);
        assertEq(usdc.balanceOf(principal), PRINCIPAL_FUNDS - VAULT_FUNDS - 5 * USDC);
    }

    function test_Deposit_RevertWhen_CallerIsNotPrincipal() public {
        usdc.mint(executor, 5 * USDC);
        vm.startPrank(executor);
        usdc.approve(address(vault), 5 * USDC);
        vm.expectRevert(MandateVault.NotPrincipal.selector);
        vault.deposit(5 * USDC);
        vm.stopPrank();
    }

    function test_Deposit_RevertWhen_AmountIsZero() public {
        vm.expectRevert(MandateVault.ZeroAmount.selector);
        vm.prank(principal);
        vault.deposit(0);
    }

    function test_Withdraw_ReturnsFundsToPrincipal() public {
        vm.expectEmit(address(vault));
        emit MandateVault.Withdrawn(principal, 40 * USDC);
        vm.prank(principal);
        vault.withdraw(40 * USDC);

        assertEq(usdc.balanceOf(address(vault)), VAULT_FUNDS - 40 * USDC);
        assertEq(usdc.balanceOf(principal), PRINCIPAL_FUNDS - VAULT_FUNDS + 40 * USDC);
    }

    function test_Withdraw_WorksWhilePaused() public {
        vm.startPrank(principal);
        vault.pause();
        vault.withdraw(VAULT_FUNDS);
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(usdc.balanceOf(principal), PRINCIPAL_FUNDS);
    }

    function test_Withdraw_RevertWhen_CallerIsNotPrincipal() public {
        address[3] memory callers = [executor, approver, attacker];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.expectRevert(MandateVault.NotPrincipal.selector);
            vm.prank(callers[i]);
            vault.withdraw(1 * USDC);
        }
        assertEq(usdc.balanceOf(address(vault)), VAULT_FUNDS);
    }

    function test_Withdraw_RevertWhen_AmountIsZero() public {
        vm.expectRevert(MandateVault.ZeroAmount.selector);
        vm.prank(principal);
        vault.withdraw(0);
    }

    function test_Withdraw_RevertWhen_MoreThanBalance() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, address(vault), VAULT_FUNDS, VAULT_FUNDS + 1
            )
        );
        vm.prank(principal);
        vault.withdraw(VAULT_FUNDS + 1);
    }

    // ------------------------------------------------------------------------------------------------------
    // createMandate
    // ------------------------------------------------------------------------------------------------------

    function test_CreateMandate_StoresTerms() public view {
        MandateVault.Mandate memory m = vault.getMandate(mandateId);
        assertEq(m.agentId, agentId);
        assertEq(m.executor, executor);
        assertEq(m.approver, approver);
        assertEq(m.payees, _payees());
        assertEq(m.perPaymentCap, PER_PAYMENT_CAP);
        assertEq(m.dailyCap, DAILY_CAP);
        assertEq(m.hardCeiling, HARD_CEILING);
        assertEq(m.validUntil, validUntil);
        assertEq(m.termsHash, TERMS_HASH);
        assertEq(m.approvalNonce, 0);
        assertFalse(m.revoked);

        assertTrue(vault.isAllowedPayee(mandateId, spendWallet));
        assertTrue(vault.isAllowedPayee(mandateId, vendorA));
        assertTrue(vault.isAllowedPayee(mandateId, vendorB));
        assertFalse(vault.isAllowedPayee(mandateId, unlistedVendor));
        assertTrue(vault.isActive(mandateId));
    }

    function test_CreateMandate_EmitsTermsAndCountsUp() public {
        vm.expectEmit(address(vault));
        emit MandateVault.MandateCreated(
            2, agentId, executor, approver, _payees(), PER_PAYMENT_CAP, DAILY_CAP, HARD_CEILING, validUntil, TERMS_HASH
        );
        uint256 second = _create(_terms());

        assertEq(second, 2);
        assertEq(_create(_terms()), 3);
        assertEq(vault.mandateCount(), 3);
    }

    function test_CreateMandate_AllowsEmptyPayeeListAndZeroAutoCaps() public {
        // An approval-only mandate: nothing can be paid without the approver.
        Terms memory t = _terms();
        t.payees = new address[](0);
        t.perPaymentCap = 0;
        t.dailyCap = 0;
        uint256 id = _create(t);

        vm.expectRevert(abi.encodeWithSelector(MandateVault.PayeeNotAllowed.selector, id, vendorA));
        vm.prank(executor);
        vault.payWithinMandate(id, vendorA, 1, keccak256("e1"));

        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, id, vendorA, 1 * USDC, keccak256("e2"), 0, deadline);
        vm.prank(executor);
        vault.payWithApproval(id, vendorA, 1 * USDC, keccak256("e2"), deadline, signature);
        assertEq(usdc.balanceOf(vendorA), 1 * USDC);
    }

    function test_CreateMandate_RevertWhen_CallerIsNotPrincipal() public {
        Terms memory t = _terms();
        address[3] memory callers = [executor, approver, attacker];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.expectRevert(MandateVault.NotPrincipal.selector);
            _createAs(callers[i], t);
        }
    }

    function test_CreateMandate_RevertWhen_ExecutorIsZero() public {
        Terms memory t = _terms();
        t.executor = address(0);
        vm.expectRevert(MandateVault.ZeroAddress.selector);
        _create(t);
    }

    function test_CreateMandate_RevertWhen_ApproverIsZero() public {
        Terms memory t = _terms();
        t.approver = address(0);
        vm.expectRevert(MandateVault.ZeroAddress.selector);
        _create(t);
    }

    function test_CreateMandate_RevertWhen_ExecutorIsAlsoApprover() public {
        Terms memory t = _terms();
        t.approver = t.executor;
        vm.expectRevert(MandateVault.ExecutorIsApprover.selector);
        _create(t);
    }

    function test_CreateMandate_RevertWhen_PerPaymentCapAboveDailyCap() public {
        Terms memory t = _terms();
        t.perPaymentCap = t.dailyCap + 1;
        vm.expectRevert(MandateVault.InvalidCaps.selector);
        _create(t);
    }

    function test_CreateMandate_RevertWhen_DailyCapAboveHardCeiling() public {
        Terms memory t = _terms();
        t.dailyCap = t.hardCeiling + 1;
        vm.expectRevert(MandateVault.InvalidCaps.selector);
        _create(t);
    }

    function test_CreateMandate_RevertWhen_HardCeilingIsZero() public {
        Terms memory t = _terms();
        t.perPaymentCap = 0;
        t.dailyCap = 0;
        t.hardCeiling = 0;
        vm.expectRevert(MandateVault.InvalidCaps.selector);
        _create(t);
    }

    function test_CreateMandate_RevertWhen_AlreadyExpired() public {
        Terms memory t = _terms();
        t.validUntil = uint64(_now());
        vm.expectRevert(MandateVault.InvalidExpiry.selector);
        _create(t);

        t.validUntil = uint64(_now()) - 1;
        vm.expectRevert(MandateVault.InvalidExpiry.selector);
        _create(t);
    }

    function test_CreateMandate_RevertWhen_TermsHashIsZero() public {
        Terms memory t = _terms();
        t.termsHash = bytes32(0);
        vm.expectRevert(MandateVault.TermsHashRequired.selector);
        _create(t);
    }

    function test_CreateMandate_RevertWhen_AgentIsNotRegistered() public {
        Terms memory t = _terms();
        t.agentId = 999;
        vm.expectRevert(abi.encodeWithSelector(MandateVault.UnknownAgent.selector, 999));
        _create(t);
    }

    function test_CreateMandate_RevertWhen_RegistryReportsNoOwner() public {
        MandateVault other = new MandateVault(usdc, principal, new ZeroOwnerRegistry());
        vm.expectRevert(abi.encodeWithSelector(MandateVault.UnknownAgent.selector, agentId));
        vm.prank(principal);
        other.createMandate(
            agentId, executor, approver, _payees(), PER_PAYMENT_CAP, DAILY_CAP, HARD_CEILING, validUntil, TERMS_HASH
        );
    }

    function test_CreateMandate_RevertWhen_APayeeIsZero() public {
        Terms memory t = _terms();
        t.payees[1] = address(0);
        vm.expectRevert(MandateVault.ZeroAddress.selector);
        _create(t);
    }

    function test_CreateMandate_RevertWhen_APayeeIsListedTwice() public {
        Terms memory t = _terms();
        t.payees[2] = t.payees[0];
        vm.expectRevert(abi.encodeWithSelector(MandateVault.DuplicatePayee.selector, spendWallet));
        _create(t);
    }

    // ------------------------------------------------------------------------------------------------------
    // payWithinMandate
    // ------------------------------------------------------------------------------------------------------

    function test_PayWithinMandate_PaysAnAllowedPayee() public {
        uint256 amount = 1_500_000; // 1.50 USDC
        bytes32 evidenceHash = _evidence();

        vm.expectEmit(address(vault));
        emit MandateVault.MandatePayment(mandateId, agentId, vendorA, amount, evidenceHash);
        vm.prank(executor);
        vault.payWithinMandate(mandateId, vendorA, amount, evidenceHash);

        assertEq(usdc.balanceOf(vendorA), amount);
        assertEq(usdc.balanceOf(address(vault)), VAULT_FUNDS - amount);
        assertEq(vault.spentToday(mandateId), amount);
        assertEq(vault.spentOnDay(mandateId, vault.today()), amount);
        assertTrue(vault.evidenceUsed(evidenceHash));
    }

    function test_PayWithinMandate_RevertWhen_CallerIsNotExecutor() public {
        address[3] memory callers = [principal, approver, attacker];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(MandateVault.NotExecutor.selector, mandateId, callers[i]));
            vm.prank(callers[i]);
            vault.payWithinMandate(mandateId, vendorA, 1 * USDC, keccak256("e"));
        }
    }

    function test_PayWithinMandate_RevertWhen_MandateDoesNotExist() public {
        vm.expectRevert(abi.encodeWithSelector(MandateVault.NotExecutor.selector, 42, executor));
        vm.prank(executor);
        vault.payWithinMandate(42, vendorA, 1 * USDC, keccak256("e"));
    }

    function test_PayWithinMandate_RevertWhen_ExecutorOfAnotherMandate() public {
        Terms memory t = _terms();
        t.executor = makeAddr("otherExecutor");
        uint256 other = _create(t);

        vm.expectRevert(abi.encodeWithSelector(MandateVault.NotExecutor.selector, other, executor));
        vm.prank(executor);
        vault.payWithinMandate(other, vendorA, 1 * USDC, keccak256("e"));
    }

    function test_PayWithinMandate_RevertWhen_PayeeIsNotAllowed() public {
        vm.expectRevert(abi.encodeWithSelector(MandateVault.PayeeNotAllowed.selector, mandateId, unlistedVendor));
        vm.prank(executor);
        vault.payWithinMandate(mandateId, unlistedVendor, 1 * USDC, keccak256("e"));
    }

    function test_PayWithinMandate_RevertWhen_AmountIsZero() public {
        vm.expectRevert(MandateVault.ZeroAmount.selector);
        vm.prank(executor);
        vault.payWithinMandate(mandateId, vendorA, 0, keccak256("e"));
    }

    function test_PayWithinMandate_PerPaymentCapIsInclusive() public {
        _pay(vendorA, PER_PAYMENT_CAP);
        assertEq(usdc.balanceOf(vendorA), PER_PAYMENT_CAP);

        vm.expectRevert(
            abi.encodeWithSelector(MandateVault.PerPaymentCapExceeded.selector, PER_PAYMENT_CAP + 1, PER_PAYMENT_CAP)
        );
        vm.prank(executor);
        vault.payWithinMandate(mandateId, vendorA, PER_PAYMENT_CAP + 1, keccak256("e"));
    }

    function test_PayWithinMandate_DailyCapIsInclusive() public {
        for (uint256 i = 0; i < 4; ++i) {
            _pay(vendorA, 2 * USDC);
        }
        assertEq(vault.spentToday(mandateId), DAILY_CAP);

        vm.expectRevert(abi.encodeWithSelector(MandateVault.DailyCapExceeded.selector, DAILY_CAP + 1, DAILY_CAP));
        vm.prank(executor);
        vault.payWithinMandate(mandateId, vendorB, 1, keccak256("e"));
    }

    function test_PayWithinMandate_DailyCapIsSharedAcrossPayees() public {
        _pay(spendWallet, 2 * USDC);
        _pay(vendorA, 2 * USDC);
        _pay(vendorB, 2 * USDC);
        _pay(vendorA, 2 * USDC);

        vm.expectRevert(abi.encodeWithSelector(MandateVault.DailyCapExceeded.selector, DAILY_CAP + 1, DAILY_CAP));
        vm.prank(executor);
        vault.payWithinMandate(mandateId, spendWallet, 1, keccak256("e"));
    }

    function test_PayWithinMandate_DailyCapResetsAtMidnightUtc() public {
        for (uint256 i = 0; i < 4; ++i) {
            _pay(vendorA, 2 * USDC);
        }

        // One second before midnight UTC the day's budget is still used up.
        uint256 midnight = (_now() / 1 days + 1) * 1 days;
        vm.warp(midnight - 1);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.DailyCapExceeded.selector, DAILY_CAP + 1, DAILY_CAP));
        vm.prank(executor);
        vault.payWithinMandate(mandateId, vendorA, 1, keccak256("e"));

        // At 00:00:00 UTC a new day starts.
        vm.warp(midnight);
        assertEq(vault.spentToday(mandateId), 0);
        _pay(vendorA, 2 * USDC);
        assertEq(vault.spentToday(mandateId), 2 * USDC);
        assertEq(vault.spentOnDay(mandateId, vault.today() - 1), DAILY_CAP);
    }

    function test_PayWithinMandate_DailyCapsAreSeparatePerMandate() public {
        uint256 second = _create(_terms());
        for (uint256 i = 0; i < 4; ++i) {
            _pay(vendorA, 2 * USDC);
        }

        vm.prank(executor);
        vault.payWithinMandate(second, vendorA, 2 * USDC, keccak256("e"));
        assertEq(vault.spentToday(second), 2 * USDC);
    }

    function test_PayWithinMandate_ExpiryIsInclusive() public {
        vm.warp(validUntil);
        _pay(vendorA, 1 * USDC);
        assertTrue(vault.isActive(mandateId));

        vm.warp(uint256(validUntil) + 1);
        assertFalse(vault.isActive(mandateId));
        vm.expectRevert(abi.encodeWithSelector(MandateVault.MandateExpired.selector, mandateId, validUntil));
        vm.prank(executor);
        vault.payWithinMandate(mandateId, vendorA, 1 * USDC, keccak256("e"));
    }

    function test_PayWithinMandate_RevertWhen_MandateIsRevoked() public {
        vm.prank(principal);
        vault.revokeMandate(mandateId);

        vm.expectRevert(abi.encodeWithSelector(MandateVault.MandateIsRevoked.selector, mandateId));
        vm.prank(executor);
        vault.payWithinMandate(mandateId, vendorA, 1 * USDC, keccak256("e"));
    }

    function test_PayWithinMandate_RevertWhen_Paused() public {
        vm.prank(principal);
        vault.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(executor);
        vault.payWithinMandate(mandateId, vendorA, 1 * USDC, keccak256("e"));

        vm.prank(principal);
        vault.unpause();
        _pay(vendorA, 1 * USDC);
        assertEq(usdc.balanceOf(vendorA), 1 * USDC);
    }

    function test_PayWithinMandate_RevertWhen_EvidenceHashIsZero() public {
        vm.expectRevert(MandateVault.EvidenceRequired.selector);
        vm.prank(executor);
        vault.payWithinMandate(mandateId, vendorA, 1 * USDC, bytes32(0));
    }

    function test_PayWithinMandate_RevertWhen_EvidenceHashIsReused() public {
        bytes32 evidenceHash = _pay(vendorA, 1 * USDC);

        vm.expectRevert(abi.encodeWithSelector(MandateVault.EvidenceAlreadyUsed.selector, evidenceHash));
        vm.prank(executor);
        vault.payWithinMandate(mandateId, vendorA, 1 * USDC, evidenceHash);

        assertEq(usdc.balanceOf(vendorA), 1 * USDC);
    }

    function test_PayWithinMandate_RevertWhen_VaultIsShortOfFunds() public {
        vm.prank(principal);
        vault.withdraw(VAULT_FUNDS - 1 * USDC);

        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(vault), 1 * USDC, 2 * USDC)
        );
        vm.prank(executor);
        vault.payWithinMandate(mandateId, vendorA, 2 * USDC, keccak256("e"));
        assertEq(vault.spentToday(mandateId), 0);
    }

    // ------------------------------------------------------------------------------------------------------
    // The "gateway compromised" drill
    // ------------------------------------------------------------------------------------------------------

    /// Whoever holds the executor key still cannot pay an address the principal never listed, pay more than
    /// the per-payment cap, or approve their own payment.
    function test_Drill_StolenExecutorKeyCannotPayTheAttacker() public {
        uint256 deadline = _now() + 1 hours;
        bytes32 evidenceHash = keccak256("drill-approval");
        bytes memory selfSigned = _signApproval(attackerKey, mandateId, attacker, 9 * USDC, evidenceHash, 0, deadline);

        vm.startPrank(executor);

        vm.expectRevert(abi.encodeWithSelector(MandateVault.PayeeNotAllowed.selector, mandateId, attacker));
        vault.payWithinMandate(mandateId, attacker, 9 * USDC, keccak256("drill-1"));

        vm.expectRevert(abi.encodeWithSelector(MandateVault.PerPaymentCapExceeded.selector, 9 * USDC, PER_PAYMENT_CAP));
        vault.payWithinMandate(mandateId, vendorA, 9 * USDC, keccak256("drill-2"));

        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vault.payWithApproval(mandateId, attacker, 9 * USDC, evidenceHash, deadline, selfSigned);

        vm.expectRevert(MandateVault.NotPrincipal.selector);
        vault.withdraw(9 * USDC);

        vm.stopPrank();

        assertEq(usdc.balanceOf(attacker), 0);
        assertEq(usdc.balanceOf(address(vault)), VAULT_FUNDS);
    }

    // ------------------------------------------------------------------------------------------------------
    // payWithApproval
    // ------------------------------------------------------------------------------------------------------

    function test_PayWithApproval_PaysAboveThePerPaymentCap() public {
        uint256 amount = 6 * USDC;
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, mandateId, vendorA, amount, evidenceHash, 0, deadline);

        vm.expectEmit(address(vault));
        emit MandateVault.ApprovedPayment(mandateId, agentId, vendorA, amount, evidenceHash, approver, 0);
        vm.prank(executor);
        vault.payWithApproval(mandateId, vendorA, amount, evidenceHash, deadline, signature);

        assertEq(usdc.balanceOf(vendorA), amount);
        assertEq(usdc.balanceOf(address(vault)), VAULT_FUNDS - amount);
        assertEq(vault.spentToday(mandateId), amount);
        assertEq(vault.getMandate(mandateId).approvalNonce, 1);
        assertTrue(vault.evidenceUsed(evidenceHash));
    }

    function test_PayWithApproval_PaysAPayeeOutsideTheAllowlist() public {
        _payApproved(unlistedVendor, 1 * USDC);
        assertEq(usdc.balanceOf(unlistedVendor), 1 * USDC);
    }

    function test_PayWithApproval_PaysPastTheDailyCap() public {
        for (uint256 i = 0; i < 4; ++i) {
            _pay(vendorA, 2 * USDC);
        }
        _payApproved(vendorA, 1 * USDC);
        assertEq(vault.spentToday(mandateId), DAILY_CAP + 1 * USDC);
    }

    function test_PayWithApproval_CountsTowardTheDayTotal() public {
        _payApproved(vendorA, 7 * USDC);

        // 7 approved + 2 would pass the 8 USDC daily cap, so the executor needs an approval again.
        vm.expectRevert(abi.encodeWithSelector(MandateVault.DailyCapExceeded.selector, 9 * USDC, DAILY_CAP));
        vm.prank(executor);
        vault.payWithinMandate(mandateId, vendorA, 2 * USDC, keccak256("e"));

        _pay(vendorA, 1 * USDC);
        assertEq(vault.spentToday(mandateId), DAILY_CAP);
    }

    function test_PayWithApproval_HardCeilingIsInclusivePerDay() public {
        _payApproved(vendorA, 12 * USDC);
        _payApproved(vendorB, 8 * USDC);
        assertEq(vault.spentToday(mandateId), HARD_CEILING);

        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, mandateId, vendorA, 1, evidenceHash, 2, deadline);
        vm.expectRevert(
            abi.encodeWithSelector(MandateVault.HardCeilingExceeded.selector, HARD_CEILING + 1, HARD_CEILING)
        );
        vm.prank(executor);
        vault.payWithApproval(mandateId, vendorA, 1, evidenceHash, deadline, signature);

        // The ceiling is per UTC day: the next day the approver can approve again.
        vm.warp((_now() / 1 days + 1) * 1 days);
        _payApproved(vendorA, HARD_CEILING);
        assertEq(vault.spentToday(mandateId), HARD_CEILING);
    }

    function test_PayWithApproval_RevertWhen_AmountAboveHardCeiling() public {
        uint256 amount = HARD_CEILING + 1;
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, mandateId, vendorA, amount, evidenceHash, 0, deadline);

        vm.expectRevert(abi.encodeWithSelector(MandateVault.HardCeilingExceeded.selector, amount, HARD_CEILING));
        vm.prank(executor);
        vault.payWithApproval(mandateId, vendorA, amount, evidenceHash, deadline, signature);
    }

    function test_PayWithApproval_RevertWhen_CallerIsNotExecutor() public {
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, mandateId, vendorA, 6 * USDC, evidenceHash, 0, deadline);

        // A valid approval is not enough on its own: only the executor can submit it.
        address[3] memory callers = [approver, attacker, vendorA];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(MandateVault.NotExecutor.selector, mandateId, callers[i]));
            vm.prank(callers[i]);
            vault.payWithApproval(mandateId, vendorA, 6 * USDC, evidenceHash, deadline, signature);
        }
    }

    function test_PayWithApproval_RevertWhen_SignedByTheWrongKey() public {
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(attackerKey, mandateId, vendorA, 6 * USDC, evidenceHash, 0, deadline);

        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vm.prank(executor);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC, evidenceHash, deadline, signature);
    }

    function test_PayWithApproval_DeadlineIsInclusive() public {
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 10 minutes;
        bytes memory signature = _signApproval(approverKey, mandateId, vendorA, 6 * USDC, evidenceHash, 0, deadline);

        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.ApprovalExpired.selector, deadline));
        vm.prank(executor);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC, evidenceHash, deadline, signature);

        vm.warp(deadline);
        vm.prank(executor);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC, evidenceHash, deadline, signature);
        assertEq(usdc.balanceOf(vendorA), 6 * USDC);
    }

    function test_PayWithApproval_RevertWhen_Replayed() public {
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, mandateId, vendorA, 6 * USDC, evidenceHash, 0, deadline);

        vm.startPrank(executor);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC, evidenceHash, deadline, signature);

        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC, evidenceHash, deadline, signature);
        vm.stopPrank();

        assertEq(usdc.balanceOf(vendorA), 6 * USDC);
    }

    function test_PayWithApproval_RevertWhen_AnyFieldIsChanged() public {
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, mandateId, vendorA, 6 * USDC, evidenceHash, 0, deadline);

        vm.startPrank(executor);

        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vault.payWithApproval(mandateId, attacker, 6 * USDC, evidenceHash, deadline, signature);

        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC + 1, evidenceHash, deadline, signature);

        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC, keccak256("other evidence"), deadline, signature);

        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC, evidenceHash, deadline + 1, signature);

        vm.stopPrank();
        assertEq(usdc.balanceOf(address(vault)), VAULT_FUNDS);
    }

    function test_PayWithApproval_RevertWhen_NonceIsNotTheCurrentOne() public {
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, mandateId, vendorA, 6 * USDC, evidenceHash, 1, deadline);

        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vm.prank(executor);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC, evidenceHash, deadline, signature);
    }

    function test_PayWithApproval_UnusedApprovalDiesWhenAnotherUsesItsNonce() public {
        uint256 deadline = _now() + 1 hours;
        bytes32 evidenceA = _evidence();
        bytes32 evidenceB = _evidence();
        bytes memory signatureA = _signApproval(approverKey, mandateId, vendorA, 6 * USDC, evidenceA, 0, deadline);
        bytes memory signatureB = _signApproval(approverKey, mandateId, vendorB, 5 * USDC, evidenceB, 0, deadline);

        vm.startPrank(executor);
        vault.payWithApproval(mandateId, vendorB, 5 * USDC, evidenceB, deadline, signatureB);

        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC, evidenceA, deadline, signatureA);
        vm.stopPrank();
    }

    function test_PayWithApproval_RevertWhen_SignedForAnotherMandate() public {
        uint256 other = _create(_terms());
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, other, vendorA, 6 * USDC, evidenceHash, 0, deadline);

        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vm.prank(executor);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC, evidenceHash, deadline, signature);
    }

    function test_PayWithApproval_RevertWhen_SignedForAnotherVault() public {
        // Same principal, token, registry, mandate id and terms, but a different contract address.
        MandateVault other = new MandateVault(usdc, principal, IIdentityRegistry(address(registry)));
        usdc.mint(address(other), VAULT_FUNDS);
        vm.prank(principal);
        uint256 otherMandate = other.createMandate(
            agentId, executor, approver, _payees(), PER_PAYMENT_CAP, DAILY_CAP, HARD_CEILING, validUntil, TERMS_HASH
        );
        assertEq(otherMandate, mandateId);

        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, mandateId, vendorA, 6 * USDC, evidenceHash, 0, deadline);

        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vm.prank(executor);
        other.payWithApproval(mandateId, vendorA, 6 * USDC, evidenceHash, deadline, signature);
    }

    function test_PayWithApproval_RevertWhen_SignedForAnotherChain() public {
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, mandateId, vendorA, 6 * USDC, evidenceHash, 0, deadline);

        vm.chainId(42_161);
        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vm.prank(executor);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC, evidenceHash, deadline, signature);
    }

    function test_PayWithApproval_RevertWhen_SignatureIsMalformed() public {
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;

        vm.startPrank(executor);
        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC, evidenceHash, deadline, "");

        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC, evidenceHash, deadline, hex"deadbeef");
        vm.stopPrank();
    }

    function test_PayWithApproval_RevertWhen_SignatureIsMalleated() public {
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes32 digest = vault.approvalDigest(mandateId, vendorA, 6 * USDC, evidenceHash, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(approverKey, digest);

        // The mirrored signature (n - s, flipped v) recovers the same signer under raw ecrecover.
        bytes32 mirroredS = bytes32(SECP256K1_N - uint256(s));
        uint8 mirroredV = v == 27 ? 28 : 27;
        assertEq(ecrecover(digest, mirroredV, r, mirroredS), approver);

        bytes memory mirrored = abi.encodePacked(r, mirroredS, mirroredV);
        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vm.prank(executor);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC, evidenceHash, deadline, mirrored);
    }

    function test_PayWithApproval_RevertWhen_PayeeIsZero() public {
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, mandateId, address(0), 6 * USDC, evidenceHash, 0, deadline);

        vm.expectRevert(MandateVault.ZeroAddress.selector);
        vm.prank(executor);
        vault.payWithApproval(mandateId, address(0), 6 * USDC, evidenceHash, deadline, signature);
    }

    function test_PayWithApproval_RevertWhen_AmountIsZero() public {
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, mandateId, vendorA, 0, evidenceHash, 0, deadline);

        vm.expectRevert(MandateVault.ZeroAmount.selector);
        vm.prank(executor);
        vault.payWithApproval(mandateId, vendorA, 0, evidenceHash, deadline, signature);
    }

    function test_PayWithApproval_RevertWhen_EvidenceHashIsZeroOrReused() public {
        uint256 deadline = _now() + 1 hours;
        bytes memory zeroEvidence = _signApproval(approverKey, mandateId, vendorA, 6 * USDC, bytes32(0), 0, deadline);
        vm.expectRevert(MandateVault.EvidenceRequired.selector);
        vm.prank(executor);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC, bytes32(0), deadline, zeroEvidence);

        bytes32 used = _pay(vendorA, 1 * USDC);
        bytes memory reused = _signApproval(approverKey, mandateId, vendorA, 6 * USDC, used, 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.EvidenceAlreadyUsed.selector, used));
        vm.prank(executor);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC, used, deadline, reused);

        assertEq(vault.getMandate(mandateId).approvalNonce, 0);
    }

    function test_PayWithApproval_RevertWhen_MandateIsRevokedExpiredOrPaused() public {
        bytes32 evidenceHash = _evidence();
        uint256 deadline = uint256(validUntil) + 1 days;
        bytes memory signature = _signApproval(approverKey, mandateId, vendorA, 6 * USDC, evidenceHash, 0, deadline);

        uint256 snapshot = vm.snapshotState();

        vm.prank(principal);
        vault.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(executor);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC, evidenceHash, deadline, signature);
        vm.revertToState(snapshot);

        vm.prank(principal);
        vault.revokeMandate(mandateId);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.MandateIsRevoked.selector, mandateId));
        vm.prank(executor);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC, evidenceHash, deadline, signature);
        vm.revertToState(snapshot);

        vm.warp(uint256(validUntil) + 1);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.MandateExpired.selector, mandateId, validUntil));
        vm.prank(executor);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC, evidenceHash, deadline, signature);
    }

    function test_PayWithApproval_AcceptsASmartAccountApprover() public {
        (address accountOwner, uint256 accountOwnerKey) = makeAddrAndKey("accountOwner");
        MockSmartAccount account = new MockSmartAccount(accountOwner);
        Terms memory t = _terms();
        t.approver = address(account);
        uint256 id = _create(t);

        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(accountOwnerKey, id, vendorA, 6 * USDC, evidenceHash, 0, deadline);

        vm.expectEmit(address(vault));
        emit MandateVault.ApprovedPayment(id, agentId, vendorA, 6 * USDC, evidenceHash, address(account), 0);
        vm.prank(executor);
        vault.payWithApproval(id, vendorA, 6 * USDC, evidenceHash, deadline, signature);
        assertEq(usdc.balanceOf(vendorA), 6 * USDC);
    }

    function test_PayWithApproval_RevertWhen_SmartAccountRejectsTheSignature() public {
        (address accountOwner, uint256 accountOwnerKey) = makeAddrAndKey("accountOwner");
        MockSmartAccount account = new MockSmartAccount(accountOwner);
        Terms memory t = _terms();
        t.approver = address(account);
        uint256 id = _create(t);

        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory byAttacker = _signApproval(attackerKey, id, vendorA, 6 * USDC, evidenceHash, 0, deadline);
        bytes memory byOwner = _signApproval(accountOwnerKey, id, vendorA, 6 * USDC, evidenceHash, 0, deadline);

        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vm.prank(executor);
        vault.payWithApproval(id, vendorA, 6 * USDC, evidenceHash, deadline, byAttacker);

        // A smart account can withdraw its approval before it is used, here by rotating its owner key.
        account.setOwner(attacker);
        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vm.prank(executor);
        vault.payWithApproval(id, vendorA, 6 * USDC, evidenceHash, deadline, byOwner);
    }

    /// The digest must be exactly what an EIP-712 wallet computes, so that a signature made in a browser
    /// wallet is accepted by the vault.
    function test_ApprovalDigest_MatchesTheEip712Encoding() public view {
        uint256 deadline = _now() + 1 hours;
        bytes32 evidenceHash = keccak256("evidence");

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("MandateVault"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "PaymentApproval(uint256 mandateId,address payee,uint256 amount,bytes32 evidenceHash,uint256 nonce,uint256 deadline)"
                ),
                mandateId,
                vendorA,
                6 * USDC,
                evidenceHash,
                uint256(0),
                deadline
            )
        );
        bytes32 expected = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        assertEq(vault.approvalDigest(mandateId, vendorA, 6 * USDC, evidenceHash, 0, deadline), expected);
    }

    // ------------------------------------------------------------------------------------------------------
    // Revoke and pause
    // ------------------------------------------------------------------------------------------------------

    function test_RevokeMandate_TakesEffectAtOnce() public {
        _pay(vendorA, 1 * USDC);

        vm.expectEmit(address(vault));
        emit MandateVault.MandateRevoked(mandateId, agentId);
        vm.prank(principal);
        vault.revokeMandate(mandateId);

        assertFalse(vault.isActive(mandateId));
        assertTrue(vault.getMandate(mandateId).revoked);

        vm.expectRevert(abi.encodeWithSelector(MandateVault.MandateIsRevoked.selector, mandateId));
        vm.prank(executor);
        vault.payWithinMandate(mandateId, vendorA, 1 * USDC, keccak256("e"));
    }

    function test_RevokeMandate_LeavesOtherMandatesAlone() public {
        uint256 second = _create(_terms());
        vm.prank(principal);
        vault.revokeMandate(mandateId);

        vm.prank(executor);
        vault.payWithinMandate(second, vendorA, 1 * USDC, keccak256("e"));
        assertTrue(vault.isActive(second));
    }

    function test_RevokeMandate_RevertWhen_CallerIsNotPrincipal() public {
        address[3] memory callers = [executor, approver, attacker];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.expectRevert(MandateVault.NotPrincipal.selector);
            vm.prank(callers[i]);
            vault.revokeMandate(mandateId);
        }
        assertTrue(vault.isActive(mandateId));
    }

    function test_RevokeMandate_RevertWhen_MandateDoesNotExist() public {
        vm.expectRevert(abi.encodeWithSelector(MandateVault.UnknownMandate.selector, 42));
        vm.prank(principal);
        vault.revokeMandate(42);
    }

    function test_RevokeMandate_RevertWhen_AlreadyRevoked() public {
        vm.startPrank(principal);
        vault.revokeMandate(mandateId);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.MandateIsRevoked.selector, mandateId));
        vault.revokeMandate(mandateId);
        vm.stopPrank();
    }

    function test_Pause_OnlyPrincipal() public {
        address[3] memory callers = [executor, approver, attacker];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.expectRevert(MandateVault.NotPrincipal.selector);
            vm.prank(callers[i]);
            vault.pause();
        }

        vm.prank(principal);
        vault.pause();
        assertTrue(vault.paused());

        for (uint256 i = 0; i < callers.length; ++i) {
            vm.expectRevert(MandateVault.NotPrincipal.selector);
            vm.prank(callers[i]);
            vault.unpause();
        }

        vm.prank(principal);
        vault.unpause();
        assertFalse(vault.paused());
    }

    function test_Pause_StillAllowsNewMandatesAndRevocation() public {
        vm.startPrank(principal);
        vault.pause();
        vault.revokeMandate(mandateId);
        vm.stopPrank();
        assertEq(_create(_terms()), 2);
    }

    // ------------------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------------------

    function test_GetMandate_RevertWhen_MandateDoesNotExist() public {
        vm.expectRevert(abi.encodeWithSelector(MandateVault.UnknownMandate.selector, 0));
        vault.getMandate(0);

        vm.expectRevert(abi.encodeWithSelector(MandateVault.UnknownMandate.selector, 2));
        vault.getMandate(2);
    }

    function test_IsActive_IsFalseForUnknownMandates() public view {
        assertFalse(vault.isActive(0));
        assertFalse(vault.isActive(2));
    }

    function test_Today_IsTheUtcDayNumber() public {
        assertEq(vault.today(), START / 1 days);
        assertEq(vault.today(), 20_770); // 2026-11-13

        vm.warp(START + 21 hours - 1); // 23:59:59 UTC
        assertEq(vault.today(), 20_770);
        vm.warp(START + 21 hours); // 00:00:00 UTC
        assertEq(vault.today(), 20_771);
    }
}
