// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MandateVault} from "../src/MandateVault.sol";
import {MandateVaultBase} from "./MandateVaultBase.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice Property tests: each one states a rule of the vault and checks it over random inputs.
contract MandateVaultFuzzTest is MandateVaultBase {
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    // ------------------------------------------------------------------------------------------------------
    // Caps
    // ------------------------------------------------------------------------------------------------------

    function testFuzz_PerPaymentCap_AmountsUpToTheCapArePaid(uint256 amount) public {
        amount = bound(amount, 1, PER_PAYMENT_CAP);
        _pay(vendorA, amount);
        assertEq(usdc.balanceOf(vendorA), amount);
        assertEq(vault.spentToday(mandateId), amount);
    }

    function testFuzz_PerPaymentCap_AmountsAboveTheCapAreRefused(uint256 amount) public {
        amount = bound(amount, PER_PAYMENT_CAP + 1, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.PerPaymentCapExceeded.selector, amount, PER_PAYMENT_CAP));
        vm.prank(executor);
        vault.payWithinMandate(mandateId, vendorA, amount, keccak256("e"));
        assertEq(usdc.balanceOf(address(vault)), VAULT_FUNDS);
    }

    /// Within one UTC day, payments are accepted exactly while the running total stays at or under the cap.
    function testFuzz_DailyCap_HoldsWithinOneDay(uint256[12] memory amounts, uint256[12] memory gaps) public {
        uint256 day = vault.today();
        uint256 spent;

        for (uint256 i = 0; i < amounts.length; ++i) {
            skip(bound(gaps[i], 0, 1 hours));
            assertEq(vault.today(), day);

            uint256 amount = bound(amounts[i], 1, PER_PAYMENT_CAP);
            bytes32 evidenceHash = _evidence();
            if (spent + amount > DAILY_CAP) {
                vm.expectRevert(
                    abi.encodeWithSelector(MandateVault.DailyCapExceeded.selector, spent + amount, DAILY_CAP)
                );
                vm.prank(executor);
                vault.payWithinMandate(mandateId, vendorA, amount, evidenceHash);
            } else {
                vm.prank(executor);
                vault.payWithinMandate(mandateId, vendorA, amount, evidenceHash);
                spent += amount;
            }
            assertEq(vault.spentToday(mandateId), spent);
        }

        assertLe(spent, DAILY_CAP);
        assertEq(usdc.balanceOf(vendorA), spent);
    }

    /// Over several days, every UTC day has its own budget and none of them is ever exceeded.
    function testFuzz_DailyCap_HoldsOnEveryDay(uint256[24] memory amounts, uint256[24] memory gaps) public {
        uint256 firstDay = vault.today();
        uint256[] memory spent = new uint256[](14);
        uint256 paid;

        for (uint256 i = 0; i < amounts.length; ++i) {
            skip(bound(gaps[i], 0, 12 hours));
            uint256 dayIndex = vault.today() - firstDay;
            uint256 amount = bound(amounts[i], 1, PER_PAYMENT_CAP);

            vm.prank(executor);
            try vault.payWithinMandate(mandateId, vendorA, amount, _evidenceFor(i)) {
                spent[dayIndex] += amount;
                paid += amount;
            } catch (bytes memory reason) {
                assertEq(bytes4(reason), MandateVault.DailyCapExceeded.selector);
                assertGt(spent[dayIndex] + amount, DAILY_CAP);
            }

            assertLe(spent[dayIndex], DAILY_CAP);
            assertEq(vault.spentOnDay(mandateId, firstDay + dayIndex), spent[dayIndex]);
        }

        assertEq(usdc.balanceOf(vendorA), paid);
        assertEq(usdc.balanceOf(address(vault)), VAULT_FUNDS - paid);
    }

    function testFuzz_Today_IsTheUtcDayOfTheBlockTime(uint64 timestamp) public {
        vm.warp(timestamp);
        assertEq(vault.today(), uint256(timestamp) / 86_400);
    }

    function testFuzz_CreateMandate_CapsMustBeOrdered(uint256 perPaymentCap, uint256 dailyCap, uint256 hardCeiling)
        public
    {
        Terms memory t = _terms();
        t.perPaymentCap = perPaymentCap;
        t.dailyCap = dailyCap;
        t.hardCeiling = hardCeiling;

        bool valid = hardCeiling > 0 && perPaymentCap <= dailyCap && dailyCap <= hardCeiling;
        if (!valid) vm.expectRevert(MandateVault.InvalidCaps.selector);
        uint256 id = _create(t);

        if (valid) {
            MandateVault.Mandate memory m = vault.getMandate(id);
            assertEq(m.perPaymentCap, perPaymentCap);
            assertEq(m.dailyCap, dailyCap);
            assertEq(m.hardCeiling, hardCeiling);
        }
    }

    // ------------------------------------------------------------------------------------------------------
    // Expiry
    // ------------------------------------------------------------------------------------------------------

    function testFuzz_Expiry_PaysUntilValidUntilAndNeverAfter(uint256 lifetime, uint256 elapsed) public {
        lifetime = bound(lifetime, 1, 365 days);
        elapsed = bound(elapsed, 0, 2 * 365 days);

        Terms memory t = _terms();
        t.validUntil = uint64(_now() + lifetime);
        uint256 id = _create(t);

        skip(elapsed);
        bool expired = elapsed > lifetime;
        assertEq(vault.isActive(id), !expired);

        // Inside the mandate.
        if (expired) vm.expectRevert(abi.encodeWithSelector(MandateVault.MandateExpired.selector, id, t.validUntil));
        vm.prank(executor);
        vault.payWithinMandate(id, vendorA, 1 * USDC, keccak256("e1"));

        // With an approval.
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, id, vendorA, 6 * USDC, keccak256("e2"), 0, deadline);
        if (expired) vm.expectRevert(abi.encodeWithSelector(MandateVault.MandateExpired.selector, id, t.validUntil));
        vm.prank(executor);
        vault.payWithApproval(id, vendorA, 6 * USDC, keccak256("e2"), deadline, signature);

        assertEq(usdc.balanceOf(vendorA), expired ? 0 : 7 * USDC);
    }

    function testFuzz_CreateMandate_ExpiryMustBeInTheFuture(uint64 expiry) public {
        Terms memory t = _terms();
        t.validUntil = expiry;
        if (expiry <= _now()) vm.expectRevert(MandateVault.InvalidExpiry.selector);
        _create(t);
    }

    // ------------------------------------------------------------------------------------------------------
    // Allowlist
    // ------------------------------------------------------------------------------------------------------

    function testFuzz_Allowlist_OnlyListedPayeesArePaidWithoutApproval(address payee, uint256 amount) public {
        amount = bound(amount, 1, PER_PAYMENT_CAP);
        bool listed = payee == spendWallet || payee == vendorA || payee == vendorB;

        if (!listed) vm.expectRevert(abi.encodeWithSelector(MandateVault.PayeeNotAllowed.selector, mandateId, payee));
        vm.prank(executor);
        vault.payWithinMandate(mandateId, payee, amount, keccak256("e"));

        assertEq(usdc.balanceOf(address(vault)), listed ? VAULT_FUNDS - amount : VAULT_FUNDS);
    }

    function testFuzz_Allowlist_FollowsTheListGivenAtCreation(address[8] memory list, uint256 used, address probe)
        public
    {
        // Build a list of distinct, non-zero payees from the fuzzed input.
        used = bound(used, 0, list.length);
        address[] memory payees = new address[](used);
        uint256 count;
        for (uint256 i = 0; i < used; ++i) {
            address candidate = list[i];
            bool fresh = candidate != address(0);
            for (uint256 j = 0; j < count && fresh; ++j) {
                if (payees[j] == candidate) fresh = false;
            }
            if (fresh) payees[count++] = candidate;
        }
        assembly ("memory-safe") {
            mstore(payees, count)
        }

        Terms memory t = _terms();
        t.payees = payees;
        uint256 id = _create(t);

        bool listed;
        for (uint256 i = 0; i < count; ++i) {
            assertTrue(vault.isAllowedPayee(id, payees[i]));
            if (payees[i] == probe) listed = true;
        }
        assertEq(vault.isAllowedPayee(id, probe), listed);
        assertEq(vault.getMandate(id).payees, payees);
    }

    // ------------------------------------------------------------------------------------------------------
    // Roles
    // ------------------------------------------------------------------------------------------------------

    function testFuzz_Roles_OnlyTheExecutorCanPay(address caller, uint256 amount) public {
        vm.assume(caller != executor);
        amount = bound(amount, 1, PER_PAYMENT_CAP);
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, mandateId, vendorA, amount, evidenceHash, 0, deadline);

        vm.startPrank(caller);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.NotExecutor.selector, mandateId, caller));
        vault.payWithinMandate(mandateId, vendorA, amount, evidenceHash);

        vm.expectRevert(abi.encodeWithSelector(MandateVault.NotExecutor.selector, mandateId, caller));
        vault.payWithApproval(mandateId, vendorA, amount, evidenceHash, deadline, signature);
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(vault)), VAULT_FUNDS);
    }

    function testFuzz_Roles_OnlyThePrincipalCanAdminister(address caller) public {
        vm.assume(caller != principal);
        Terms memory t = _terms();

        vm.startPrank(caller);
        vm.expectRevert(MandateVault.NotPrincipal.selector);
        vault.deposit(1 * USDC);
        vm.expectRevert(MandateVault.NotPrincipal.selector);
        vault.withdraw(1 * USDC);
        vm.expectRevert(MandateVault.NotPrincipal.selector);
        vault.createMandate(
            t.agentId,
            t.executor,
            t.approver,
            t.payees,
            t.perPaymentCap,
            t.dailyCap,
            t.hardCeiling,
            t.validUntil,
            t.termsHash
        );
        vm.expectRevert(MandateVault.NotPrincipal.selector);
        vault.revokeMandate(mandateId);
        vm.expectRevert(MandateVault.NotPrincipal.selector);
        vault.pause();
        vm.expectRevert(MandateVault.NotPrincipal.selector);
        vault.unpause();
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------------------
    // Approvals
    // ------------------------------------------------------------------------------------------------------

    function testFuzz_Approval_AnyOtherSignerIsRejected(uint256 signerKey, uint256 amount) public {
        signerKey = bound(signerKey, 1, SECP256K1_N - 1);
        vm.assume(vm.addr(signerKey) != approver);
        amount = bound(amount, 1, HARD_CEILING);

        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(signerKey, mandateId, vendorA, amount, evidenceHash, 0, deadline);

        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vm.prank(executor);
        vault.payWithApproval(mandateId, vendorA, amount, evidenceHash, deadline, signature);
        assertEq(usdc.balanceOf(address(vault)), VAULT_FUNDS);
    }

    function testFuzz_Approval_WorksUntilItsDeadlineAndNeverAfter(uint256 window, uint256 elapsed) public {
        window = bound(window, 0, 7 days);
        elapsed = bound(elapsed, 0, 14 days);

        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + window;
        bytes memory signature = _signApproval(approverKey, mandateId, vendorA, 6 * USDC, evidenceHash, 0, deadline);

        skip(elapsed);
        bool expired = elapsed > window;
        if (expired) vm.expectRevert(abi.encodeWithSelector(MandateVault.ApprovalExpired.selector, deadline));
        vm.prank(executor);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC, evidenceHash, deadline, signature);

        assertEq(usdc.balanceOf(vendorA), expired ? 0 : 6 * USDC);
    }

    function testFuzz_Approval_CannotBeReplayed(address payee, uint256 amount, uint256 wait) public {
        vm.assume(payee != address(0) && payee != address(vault));
        amount = bound(amount, 1, HARD_CEILING / 2);
        wait = bound(wait, 0, 3 days);

        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 7 days;
        bytes memory signature = _signApproval(approverKey, mandateId, payee, amount, evidenceHash, 0, deadline);

        uint256 balanceBefore = usdc.balanceOf(payee);
        vm.prank(executor);
        vault.payWithApproval(mandateId, payee, amount, evidenceHash, deadline, signature);
        assertEq(usdc.balanceOf(payee), balanceBefore + amount);

        // The same signature is refused later the same day and on later days.
        skip(wait);
        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vm.prank(executor);
        vault.payWithApproval(mandateId, payee, amount, evidenceHash, deadline, signature);
        assertEq(usdc.balanceOf(payee), balanceBefore + amount);
        assertEq(vault.getMandate(mandateId).approvalNonce, 1);
    }

    /// An approval covers one payee, one amount, one evidence record and one deadline. Changing any of them
    /// makes the signature worthless.
    function testFuzz_Approval_IsBoundToEveryField(
        address payee,
        uint256 amount,
        bytes32 evidenceHash,
        uint256 window,
        uint8 fieldToChange
    ) public {
        vm.assume(payee != address(0) && payee != address(vault));
        vm.assume(evidenceHash != bytes32(0));
        amount = bound(amount, 2, HARD_CEILING - 1);
        window = bound(window, 1 hours, 7 days);
        uint256 deadline = _now() + window;
        bytes memory signature = _signApproval(approverKey, mandateId, payee, amount, evidenceHash, 0, deadline);

        address submittedPayee = payee;
        uint256 submittedAmount = amount;
        bytes32 submittedEvidence = evidenceHash;
        uint256 submittedDeadline = deadline;
        fieldToChange = fieldToChange % 5;
        if (fieldToChange == 0) submittedPayee = attacker;
        if (fieldToChange == 1) submittedAmount = amount + 1;
        if (fieldToChange == 2) submittedAmount = amount - 1;
        if (fieldToChange == 3) submittedEvidence = keccak256(abi.encode(evidenceHash));
        if (fieldToChange == 4) submittedDeadline = deadline + 1;
        vm.assume(submittedPayee != payee || fieldToChange != 0);

        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vm.prank(executor);
        vault.payWithApproval(
            mandateId, submittedPayee, submittedAmount, submittedEvidence, submittedDeadline, signature
        );

        // Unchanged, the same signature is accepted.
        uint256 balanceBefore = usdc.balanceOf(payee);
        vm.prank(executor);
        vault.payWithApproval(mandateId, payee, amount, evidenceHash, deadline, signature);
        assertEq(usdc.balanceOf(payee), balanceBefore + amount);
    }

    function testFuzz_Approval_NonceMustBeTheCurrentOne(uint256 nonce) public {
        vm.assume(nonce != 0);
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, mandateId, vendorA, 6 * USDC, evidenceHash, nonce, deadline);

        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vm.prank(executor);
        vault.payWithApproval(mandateId, vendorA, 6 * USDC, evidenceHash, deadline, signature);
    }

    /// No approval lifts the hard ceiling: the day's total, earlier payments included, stays at or under it.
    function testFuzz_Approval_NeverLiftsTheHardCeiling(uint256 alreadySpent, uint256 amount) public {
        alreadySpent = bound(alreadySpent, 0, HARD_CEILING);
        amount = bound(amount, 1, 2 * HARD_CEILING);
        if (alreadySpent > 0) _payApproved(vendorB, alreadySpent);

        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        uint256 nonce = vault.getMandate(mandateId).approvalNonce;
        bytes memory signature = _signApproval(approverKey, mandateId, vendorA, amount, evidenceHash, nonce, deadline);

        bool over = alreadySpent + amount > HARD_CEILING;
        if (over) {
            vm.expectRevert(
                abi.encodeWithSelector(MandateVault.HardCeilingExceeded.selector, alreadySpent + amount, HARD_CEILING)
            );
        }
        vm.prank(executor);
        vault.payWithApproval(mandateId, vendorA, amount, evidenceHash, deadline, signature);

        assertEq(vault.spentToday(mandateId), over ? alreadySpent : alreadySpent + amount);
        assertLe(vault.spentToday(mandateId), HARD_CEILING);
    }

    // ------------------------------------------------------------------------------------------------------
    // Revoke and pause
    // ------------------------------------------------------------------------------------------------------

    function testFuzz_Revoke_StopsEveryPaymentFromThatMomentOn(uint256 amount, uint256 wait) public {
        amount = bound(amount, 1, PER_PAYMENT_CAP);
        wait = bound(wait, 0, 60 days);

        vm.prank(principal);
        vault.revokeMandate(mandateId);
        skip(wait);

        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, mandateId, vendorA, amount, evidenceHash, 0, deadline);

        vm.startPrank(executor);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.MandateIsRevoked.selector, mandateId));
        vault.payWithinMandate(mandateId, vendorA, amount, evidenceHash);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.MandateIsRevoked.selector, mandateId));
        vault.payWithApproval(mandateId, vendorA, amount, evidenceHash, deadline, signature);
        vm.stopPrank();

        assertFalse(vault.isActive(mandateId));
        assertEq(usdc.balanceOf(address(vault)), VAULT_FUNDS);
    }

    function testFuzz_Pause_StopsEveryPaymentUntilUnpaused(uint256 amount) public {
        amount = bound(amount, 1, PER_PAYMENT_CAP);
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, mandateId, vendorA, amount, evidenceHash, 0, deadline);

        vm.prank(principal);
        vault.pause();

        vm.startPrank(executor);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.payWithinMandate(mandateId, vendorA, amount, evidenceHash);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.payWithApproval(mandateId, vendorA, amount, evidenceHash, deadline, signature);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(vault)), VAULT_FUNDS);

        vm.prank(principal);
        vault.unpause();
        vm.prank(executor);
        vault.payWithinMandate(mandateId, vendorA, amount, evidenceHash);
        assertEq(usdc.balanceOf(vendorA), amount);
    }

    // ------------------------------------------------------------------------------------------------------
    // Funds
    // ------------------------------------------------------------------------------------------------------

    function testFuzz_Funds_DepositAndWithdrawRoundTrip(uint256 depositAmount, uint256 withdrawAmount) public {
        depositAmount = bound(depositAmount, 1, PRINCIPAL_FUNDS - VAULT_FUNDS);
        withdrawAmount = bound(withdrawAmount, 1, VAULT_FUNDS + depositAmount);

        vm.startPrank(principal);
        vault.deposit(depositAmount);
        vault.withdraw(withdrawAmount);
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(vault)), VAULT_FUNDS + depositAmount - withdrawAmount);
        assertEq(usdc.balanceOf(address(vault)) + usdc.balanceOf(principal), PRINCIPAL_FUNDS);
    }

    function testFuzz_Evidence_EachHashAnchorsOnePayment(bytes32 evidenceHash, uint256 amount) public {
        vm.assume(evidenceHash != bytes32(0));
        amount = bound(amount, 1, PER_PAYMENT_CAP);

        vm.startPrank(executor);
        vault.payWithinMandate(mandateId, vendorA, amount, evidenceHash);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.EvidenceAlreadyUsed.selector, evidenceHash));
        vault.payWithinMandate(mandateId, vendorB, amount, evidenceHash);
        vm.stopPrank();

        assertEq(usdc.balanceOf(vendorA), amount);
        assertEq(usdc.balanceOf(vendorB), 0);
    }

    function _evidenceFor(uint256 i) private pure returns (bytes32) {
        return keccak256(abi.encode("fuzz evidence", i));
    }
}
