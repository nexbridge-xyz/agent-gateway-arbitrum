// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MandateVault} from "../../src/MandateVault.sol";
import {IIdentityRegistry} from "../../src/interfaces/IIdentityRegistry.sol";
import {MandateVaultBase} from "../MandateVaultBase.sol";
import {MockSmartAccount} from "../mocks/MockSmartAccount.sol";
import {
    ApproverThatBurnsAllGas,
    ApproverThatReturnsNothing,
    ApproverThatReverts,
    ApproverThatWritesState,
    ApproverWithDirtyMagic,
    ApproverWithLongAnswer,
    ApproverWithShortAnswer,
    ApproverWithWrongMagic,
    BlocklistToken,
    FalseReturnToken,
    FeeToken,
    Forwarder,
    HookToken,
    NoReturnToken,
    ReentrantExecutor
} from "./mocks/ReviewMocks.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {stdError} from "forge-std/StdError.sol";

/// @notice Review: properties of MandateVault that were attacked and found holding.
/// Every test here passes on the reviewed commit.
contract ReviewPropertiesTest is MandateVaultBase {
    // ------------------------------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------------------------------

    /// @dev A mandate like the demo's, with `approver_` as approver.
    function _mandateWithApprover(address approver_) internal returns (uint256) {
        Terms memory t = _terms();
        t.approver = approver_;
        return _create(t);
    }

    /// @dev Tries an approved payment with the real approver key's signature and expects InvalidApproval,
    /// then checks that nothing was used up.
    function _expectRefusedAndUntouched(uint256 id, uint256 gasLimit) internal {
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, id, unlistedVendor, 3 * USDC, evidenceHash, 0, deadline);
        uint256 vaultBefore = usdc.balanceOf(address(vault));

        vm.prank(executor);
        if (gasLimit == 0) {
            vm.expectRevert(MandateVault.InvalidApproval.selector);
            vault.payWithApproval(id, unlistedVendor, 3 * USDC, evidenceHash, deadline, signature);
        } else {
            vm.expectRevert();
            vault.payWithApproval{gas: gasLimit}(id, unlistedVendor, 3 * USDC, evidenceHash, deadline, signature);
        }

        assertEq(vault.getMandate(id).approvalNonce, 0, "nonce must not move");
        assertEq(vault.spentToday(id), 0, "nothing counted");
        assertFalse(vault.evidenceUsed(evidenceHash), "evidence hash still free");
        assertEq(usdc.balanceOf(address(vault)), vaultBefore, "no funds moved");
    }

    // ------------------------------------------------------------------------------------------------
    // ERC-1271 approvers that answer in unusual ways
    // ------------------------------------------------------------------------------------------------

    function test_Erc1271_ApproverThatReverts_IsANo() public {
        _expectRefusedAndUntouched(_mandateWithApprover(address(new ApproverThatReverts())), 0);
    }

    function test_Erc1271_WrongMagicValue_IsANo() public {
        _expectRefusedAndUntouched(_mandateWithApprover(address(new ApproverWithWrongMagic())), 0);
    }

    function test_Erc1271_EmptyAnswer_IsANo() public {
        // A contract whose fallback accepts every call must not count as an approver that said yes.
        _expectRefusedAndUntouched(_mandateWithApprover(address(new ApproverThatReturnsNothing())), 0);
    }

    function test_Erc1271_ShortAnswer_IsANo() public {
        _expectRefusedAndUntouched(_mandateWithApprover(address(new ApproverWithShortAnswer())), 0);
    }

    function test_Erc1271_MagicFollowedByOtherBytesInTheSameWord_IsANo() public {
        _expectRefusedAndUntouched(_mandateWithApprover(address(new ApproverWithDirtyMagic())), 0);
    }

    function test_Erc1271_ApproverThatBurnsAllGas_CannotForceAPayment() public {
        // The static call gets 63/64 of the gas and fails; what is left is enough to refuse.
        _expectRefusedAndUntouched(_mandateWithApprover(address(new ApproverThatBurnsAllGas())), 400_000);
    }

    function test_Erc1271_ApproverCannotWriteStateWhileAsked() public {
        ApproverThatWritesState account = new ApproverThatWritesState();
        _expectRefusedAndUntouched(_mandateWithApprover(address(account)), 0);
        assertEq(account.asked(), 0);
    }

    function test_Erc1271_AnswerLongerThanOneWord_IsRead_AsItsFirstWord() public {
        // Recorded as a fact about the pinned OpenZeppelin version: one word is read, more is ignored.
        uint256 id = _mandateWithApprover(address(new ApproverWithLongAnswer()));
        bytes32 evidenceHash = _evidence();
        vm.prank(executor);
        vault.payWithApproval(id, unlistedVendor, 3 * USDC, evidenceHash, _now() + 1, hex"00");
        assertEq(usdc.balanceOf(unlistedVendor), 3 * USDC);
    }

    function test_Erc1271_NewOwnerOfTheSmartAccount_CannotUseTheOldOwnersApproval() public {
        MockSmartAccount account = new MockSmartAccount(approver);
        uint256 id = _mandateWithApprover(address(account));
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, id, unlistedVendor, 3 * USDC, evidenceHash, 0, deadline);

        // The account changes hands before the executor submits. The old owner's signature is void.
        account.setOwner(attacker);
        vm.prank(executor);
        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vault.payWithApproval(id, unlistedVendor, 3 * USDC, evidenceHash, deadline, signature);
    }

    function test_Erc1271_OwnerKeyOfTwoSmartAccounts_OneApprovalServesOneMandateOnly() public {
        // One person's key owns two smart accounts, each the approver of a mandate. The raw digest names
        // the mandate, so a signature for one mandate is useless for the other.
        uint256 first = _mandateWithApprover(address(new MockSmartAccount(approver)));
        uint256 second = _mandateWithApprover(address(new MockSmartAccount(approver)));
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, first, unlistedVendor, 3 * USDC, evidenceHash, 0, deadline);

        vm.prank(executor);
        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vault.payWithApproval(second, unlistedVendor, 3 * USDC, evidenceHash, deadline, signature);

        vm.prank(executor);
        vault.payWithApproval(first, unlistedVendor, 3 * USDC, evidenceHash, deadline, signature);
        assertEq(usdc.balanceOf(unlistedVendor), 3 * USDC);
    }

    // ------------------------------------------------------------------------------------------------
    // Approvals: what a signature covers, and for how long
    // ------------------------------------------------------------------------------------------------

    function test_Approval_SameTermsOnASecondVault_AreNotApprovedThere() public {
        // A second vault of the same principal, with the same mandate id, executor and approver.
        MandateVault other = new MandateVault(usdc, principal, IIdentityRegistry(address(registry)));
        vm.startPrank(principal);
        usdc.approve(address(other), type(uint256).max);
        other.deposit(50 * USDC);
        uint256 otherId = other.createMandate(
            agentId, executor, approver, _payees(), PER_PAYMENT_CAP, DAILY_CAP, HARD_CEILING, validUntil, TERMS_HASH
        );
        vm.stopPrank();
        assertEq(otherId, mandateId, "same mandate id on both vaults");

        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature =
            _signApproval(approverKey, mandateId, unlistedVendor, 6 * USDC, evidenceHash, 0, deadline);

        vm.prank(executor);
        vm.expectRevert(MandateVault.InvalidApproval.selector);
        other.payWithApproval(otherId, unlistedVendor, 6 * USDC, evidenceHash, deadline, signature);

        vm.prank(executor);
        vault.payWithApproval(mandateId, unlistedVendor, 6 * USDC, evidenceHash, deadline, signature);
    }

    function test_Approval_AfterAChainSplit_TheOtherChainRefusesIt() public {
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature =
            _signApproval(approverKey, mandateId, unlistedVendor, 6 * USDC, evidenceHash, 0, deadline);

        // The same contract at the same address on a chain with another id: the domain no longer matches.
        uint256 original = vm.getChainId();
        vm.chainId(42_161);
        vm.prank(executor);
        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vault.payWithApproval(mandateId, unlistedVendor, 6 * USDC, evidenceHash, deadline, signature);

        vm.chainId(original);
        vm.prank(executor);
        vault.payWithApproval(mandateId, unlistedVendor, 6 * USDC, evidenceHash, deadline, signature);
    }

    function test_Approval_CannotBeSubmittedByAnyoneButTheExecutor_EvenTheApprover() public {
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature =
            _signApproval(approverKey, mandateId, unlistedVendor, 6 * USDC, evidenceHash, 0, deadline);

        address[3] memory callers = [approver, principal, unlistedVendor];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(MandateVault.NotExecutor.selector, mandateId, callers[i]));
            vault.payWithApproval(mandateId, unlistedVendor, 6 * USDC, evidenceHash, deadline, signature);
        }
    }

    function test_Approval_FailedSubmission_UsesNothingUp() public {
        // The vault is short of funds when the approved payment arrives. Nothing may be consumed, so the
        // same approval still works once the principal has topped the vault up.
        vm.prank(principal);
        vault.withdraw(VAULT_FUNDS);

        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature =
            _signApproval(approverKey, mandateId, unlistedVendor, 6 * USDC, evidenceHash, 0, deadline);

        vm.prank(executor);
        vm.expectRevert();
        vault.payWithApproval(mandateId, unlistedVendor, 6 * USDC, evidenceHash, deadline, signature);
        assertEq(vault.getMandate(mandateId).approvalNonce, 0);
        assertFalse(vault.evidenceUsed(evidenceHash));
        assertEq(vault.spentToday(mandateId), 0);

        vm.prank(principal);
        vault.deposit(6 * USDC);
        vm.prank(executor);
        vault.payWithApproval(mandateId, unlistedVendor, 6 * USDC, evidenceHash, deadline, signature);
        assertEq(usdc.balanceOf(unlistedVendor), 6 * USDC);
    }

    function test_Approval_RevokedMandate_KillsEverySignedApproval() public {
        bytes32 evidenceHash = _evidence();
        uint256 deadline = type(uint256).max; // an approval with no end
        bytes memory signature =
            _signApproval(approverKey, mandateId, unlistedVendor, 6 * USDC, evidenceHash, 0, deadline);

        vm.prank(principal);
        vault.revokeMandate(mandateId);

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.MandateIsRevoked.selector, mandateId));
        vault.payWithApproval(mandateId, unlistedVendor, 6 * USDC, evidenceHash, deadline, signature);
    }

    function testFuzz_Approval_SignatureForOneNonce_NeverWorksForAnother(uint8 used, uint8 signedFor) public {
        used = uint8(bound(used, 0, 6));
        vm.assume(signedFor != used);
        for (uint256 i = 0; i < used; ++i) {
            _payApproved(unlistedVendor, 1 * USDC);
        }
        assertEq(vault.getMandate(mandateId).approvalNonce, used);

        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature =
            _signApproval(approverKey, mandateId, unlistedVendor, 1 * USDC, evidenceHash, signedFor, deadline);
        vm.prank(executor);
        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vault.payWithApproval(mandateId, unlistedVendor, 1 * USDC, evidenceHash, deadline, signature);
    }

    // ------------------------------------------------------------------------------------------------
    // Roles: who the vault takes the caller to be
    // ------------------------------------------------------------------------------------------------

    function test_Roles_AContractCalledByTheExecutor_IsNotTheExecutor() public {
        // The vault looks at the caller, never at who started the transaction.
        Forwarder forwarder = new Forwarder();
        bytes memory call = abi.encodeCall(MandateVault.payWithinMandate, (mandateId, vendorA, 1 * USDC, _evidence()));
        vm.prank(executor, executor);
        (bool ok, bytes memory result) = forwarder.forward(address(vault), call);
        assertFalse(ok);
        assertEq(bytes4(result), MandateVault.NotExecutor.selector);
    }

    function test_Roles_AContractCalledByThePrincipal_IsNotThePrincipal() public {
        Forwarder forwarder = new Forwarder();
        vm.prank(principal, principal);
        (bool ok, bytes memory result) =
            forwarder.forward(address(vault), abi.encodeCall(MandateVault.withdraw, (1 * USDC)));
        assertFalse(ok);
        assertEq(bytes4(result), MandateVault.NotPrincipal.selector);
    }

    function test_Roles_ExecutorOfOneMandate_CannotTouchAnother_WithOrWithoutApproval() public {
        Terms memory t = _terms();
        t.executor = makeAddr("otherExecutor");
        uint256 other = _create(t);

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.NotExecutor.selector, other, executor));
        vault.payWithinMandate(other, vendorA, 1 * USDC, _evidence());

        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, other, vendorA, 1 * USDC, evidenceHash, 0, deadline);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.NotExecutor.selector, other, executor));
        vault.payWithApproval(other, vendorA, 1 * USDC, evidenceHash, deadline, signature);
    }

    // ------------------------------------------------------------------------------------------------
    // Pause and revoke
    // ------------------------------------------------------------------------------------------------

    function test_Pause_BlocksBothKindsOfPayment_AndNothingElse() public {
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature =
            _signApproval(approverKey, mandateId, unlistedVendor, 6 * USDC, evidenceHash, 0, deadline);

        vm.prank(principal);
        vault.pause();

        vm.startPrank(executor);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.payWithinMandate(mandateId, vendorA, 1 * USDC, _evidence());
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.payWithApproval(mandateId, unlistedVendor, 6 * USDC, evidenceHash, deadline, signature);
        vm.stopPrank();

        // The principal can still take everything out and revoke.
        vm.startPrank(principal);
        vault.withdraw(VAULT_FUNDS);
        vault.revokeMandate(mandateId);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function test_Pause_OnlyThePrincipalCanUnpause() public {
        vm.prank(principal);
        vault.pause();
        address[3] memory callers = [executor, approver, attacker];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(MandateVault.NotPrincipal.selector);
            vault.unpause();
        }
        assertTrue(vault.paused());
    }

    // ------------------------------------------------------------------------------------------------
    // Day buckets and integer edges
    // ------------------------------------------------------------------------------------------------

    function testFuzz_Day_ChangesExactlyAtMidnightUtc(uint32 day) public {
        day = uint32(bound(day, _now() / 1 days + 1, _now() / 1 days + 25));
        uint256 midnight = uint256(day) * 1 days;

        vm.warp(midnight - 1);
        assertEq(vault.today(), uint256(day) - 1);
        _pay(vendorA, PER_PAYMENT_CAP);
        assertEq(vault.spentOnDay(mandateId, uint256(day) - 1), PER_PAYMENT_CAP);

        vm.warp(midnight);
        assertEq(vault.today(), day);
        assertEq(vault.spentToday(mandateId), 0, "the new day starts empty");
        _pay(vendorA, PER_PAYMENT_CAP);
        assertEq(vault.spentOnDay(mandateId, day), PER_PAYMENT_CAP);
        assertEq(vault.spentOnDay(mandateId, uint256(day) - 1), PER_PAYMENT_CAP, "yesterday is not rewritten");
    }

    function test_Day_TwoHardCeilingsCanLeaveWithinTwoSeconds_AcrossMidnight() public {
        // Stated in SECURITY.md for the daily cap. It holds for the hard ceiling as well: the ceiling is
        // per UTC day, not per 24 hours.
        uint256 midnight = (_now() / 1 days + 1) * 1 days;
        vm.warp(midnight - 1);
        _payApproved(unlistedVendor, HARD_CEILING);
        vm.warp(midnight);
        _payApproved(unlistedVendor, HARD_CEILING);
        assertEq(usdc.balanceOf(unlistedVendor), 2 * HARD_CEILING);
    }

    function test_Edge_HugeAmounts_RevertInsteadOfWrapping() public {
        Terms memory t = _terms();
        t.perPaymentCap = type(uint256).max;
        t.dailyCap = type(uint256).max;
        t.hardCeiling = type(uint256).max;
        uint256 id = _create(t);

        vm.startPrank(executor);
        vault.payWithinMandate(id, vendorA, 1, _evidence());
        // 1 + (2^256 - 1) would wrap to 0 and pass every cap. Checked arithmetic stops it.
        vm.expectRevert(stdError.arithmeticError);
        vault.payWithinMandate(id, vendorA, type(uint256).max, _evidence());
        vm.stopPrank();

        bytes32 evidenceHash = _evidence();
        bytes memory signature =
            _signApproval(approverKey, id, vendorA, type(uint256).max, evidenceHash, 0, type(uint256).max);
        vm.prank(executor);
        vm.expectRevert(stdError.arithmeticError);
        vault.payWithApproval(id, vendorA, type(uint256).max, evidenceHash, type(uint256).max, signature);
    }

    function test_Edge_MandateWithoutEndDate_PaysFarInTheFuture() public {
        Terms memory t = _terms();
        t.validUntil = type(uint64).max;
        uint256 id = _create(t);
        vm.warp(uint256(type(uint64).max));
        vm.prank(executor);
        vault.payWithinMandate(id, vendorA, 1 * USDC, _evidence());
        assertTrue(vault.isActive(id));
    }

    function test_Edge_MandateIdZeroAndTheNextId_DoNotExist() public {
        uint256 next = vault.mandateCount() + 1;
        uint256[2] memory ids = [uint256(0), next];
        for (uint256 i = 0; i < ids.length; ++i) {
            assertFalse(vault.isActive(ids[i]));
            vm.prank(executor);
            vm.expectRevert(abi.encodeWithSelector(MandateVault.NotExecutor.selector, ids[i], executor));
            vault.payWithinMandate(ids[i], vendorA, 1, _evidence());
            // Nobody is the executor of a mandate that does not exist: not even the zero address.
            vm.prank(address(0));
            vm.expectRevert(abi.encodeWithSelector(MandateVault.MandateExpired.selector, ids[i], uint64(0)));
            vault.payWithinMandate(ids[i], vendorA, 1, _evidence());
        }
    }

    // ------------------------------------------------------------------------------------------------
    // Evidence hashes
    // ------------------------------------------------------------------------------------------------

    function test_Evidence_OneHash_OnePayment_AcrossBothFunctions() public {
        bytes32 evidenceHash = _pay(vendorA, 1 * USDC);
        uint256 deadline = _now() + 1 hours;
        bytes memory signature =
            _signApproval(approverKey, mandateId, unlistedVendor, 1 * USDC, evidenceHash, 0, deadline);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.EvidenceAlreadyUsed.selector, evidenceHash));
        vault.payWithApproval(mandateId, unlistedVendor, 1 * USDC, evidenceHash, deadline, signature);
        // The refused call left the approval number alone.
        assertEq(vault.getMandate(mandateId).approvalNonce, 0);
    }

    // ------------------------------------------------------------------------------------------------
    // Events: what a verifier reads back
    // ------------------------------------------------------------------------------------------------

    function test_Events_CarryThePaymentAsItWasMade() public {
        bytes32 first = _evidence();
        vm.expectEmit(address(vault));
        emit MandateVault.MandatePayment(mandateId, agentId, vendorA, 1 * USDC, first);
        vm.prank(executor);
        vault.payWithinMandate(mandateId, vendorA, 1 * USDC, first);

        bytes32 second = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _signApproval(approverKey, mandateId, unlistedVendor, 6 * USDC, second, 0, deadline);
        vm.expectEmit(address(vault));
        emit MandateVault.ApprovedPayment(mandateId, agentId, unlistedVendor, 6 * USDC, second, approver, 0);
        vm.prank(executor);
        vault.payWithApproval(mandateId, unlistedVendor, 6 * USDC, second, deadline, signature);
    }
}

/// @notice Review: what the vault does with tokens that are not plain ERC-20. The contract says it
/// assumes a plain token such as USDC; these tests pin down what "assumes" means.
contract ReviewTokenTest is MandateVaultBase {
    using SafeERC20 for IERC20;

    function _vaultFor(address token) internal returns (MandateVault other, uint256 id) {
        other = new MandateVault(IERC20(token), principal, IIdentityRegistry(address(registry)));
        vm.prank(principal);
        id = other.createMandate(
            agentId, executor, approver, _payees(), PER_PAYMENT_CAP, DAILY_CAP, HARD_CEILING, validUntil, TERMS_HASH
        );
    }

    function test_Token_BlockedPayee_PaymentRevertsAndUsesNothingUp() public {
        BlocklistToken token = new BlocklistToken();
        (MandateVault other, uint256 id) = _vaultFor(address(token));
        token.mint(address(other), 50 * USDC);
        token.setBlocked(vendorA, true);

        bytes32 evidenceHash = _evidence();
        vm.prank(executor);
        vm.expectRevert(bytes("blocked"));
        other.payWithinMandate(id, vendorA, 1 * USDC, evidenceHash);

        assertEq(other.spentToday(id), 0);
        assertFalse(other.evidenceUsed(evidenceHash));

        // Other payees are not held up by the blocked one.
        vm.prank(executor);
        other.payWithinMandate(id, vendorB, 1 * USDC, evidenceHash);
        assertEq(token.balanceOf(vendorB), 1 * USDC);
    }

    function test_Token_BlockedVault_PrincipalCannotWithdraw_NothingElseBreaks() public {
        // If the issuer blocks the vault itself the funds are stuck, as SECURITY.md says. No call here
        // can make that worse or move them.
        BlocklistToken token = new BlocklistToken();
        (MandateVault other, uint256 id) = _vaultFor(address(token));
        token.mint(address(other), 50 * USDC);
        token.setBlocked(address(other), true);

        vm.prank(principal);
        vm.expectRevert(bytes("blocked"));
        other.withdraw(1 * USDC);
        vm.prank(executor);
        vm.expectRevert(bytes("blocked"));
        other.payWithinMandate(id, vendorA, 1 * USDC, _evidence());
        assertEq(token.balanceOf(address(other)), 50 * USDC);
    }

    function test_Token_ThatReturnsFalse_IsTreatedAsFailed() public {
        FalseReturnToken token = new FalseReturnToken();
        (MandateVault other, uint256 id) = _vaultFor(address(token));
        token.mint(address(other), 50 * USDC);
        token.setRefuse(true);

        bytes32 evidenceHash = _evidence();
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(token)));
        other.payWithinMandate(id, vendorA, 1 * USDC, evidenceHash);
        assertEq(other.spentToday(id), 0);
        assertFalse(other.evidenceUsed(evidenceHash));
    }

    function test_Token_WithoutReturnValue_IsPaid() public {
        NoReturnToken token = new NoReturnToken();
        (MandateVault other, uint256 id) = _vaultFor(address(token));
        token.mint(principal, 10 * USDC);
        vm.startPrank(principal);
        token.approve(address(other), 10 * USDC);
        other.deposit(10 * USDC);
        vm.stopPrank();

        vm.prank(executor);
        other.payWithinMandate(id, vendorA, 2 * USDC, _evidence());
        assertEq(token.balanceOf(vendorA), 2 * USDC);
        assertEq(token.balanceOf(address(other)), 8 * USDC);
    }

    function test_Token_WithTransferFee_VaultCountsWhatItSent_NotWhatArrived() public {
        // Not supported, and stated so in the contract. The caps still bound what leaves the vault.
        FeeToken token = new FeeToken();
        (MandateVault other, uint256 id) = _vaultFor(address(token));
        token.mint(address(other), 50 * USDC);

        vm.prank(executor);
        other.payWithinMandate(id, vendorA, 2 * USDC, _evidence());
        assertEq(other.spentToday(id), 2 * USDC);
        assertEq(token.balanceOf(vendorA), 2 * USDC - 2 * USDC / 100);
        assertEq(token.balanceOf(address(other)), 48 * USDC, "exactly the counted amount left the vault");
    }

    function test_Token_WithReceiveHook_ReentrantExecutorCannotBeatTheDailyCap() public {
        HookToken token = new HookToken();
        ReentrantExecutor thief = new ReentrantExecutor();
        MandateVault other = new MandateVault(IERC20(address(token)), principal, IIdentityRegistry(address(registry)));
        address[] memory payees = new address[](1);
        payees[0] = address(thief);
        vm.prank(principal);
        uint256 id = other.createMandate(
            agentId, address(thief), approver, payees, PER_PAYMENT_CAP, DAILY_CAP, HARD_CEILING, validUntil, TERMS_HASH
        );
        token.mint(address(other), 100 * USDC);

        // Every payment calls back into the executor, which asks for another payment, 50 times over.
        thief.configure(other, id, PER_PAYMENT_CAP, 50);
        thief.pay(keccak256("first"));

        assertEq(token.balanceOf(address(thief)), DAILY_CAP, "exactly the daily cap, never more");
        assertEq(other.spentToday(id), DAILY_CAP);
        assertEq(thief.reentered(), DAILY_CAP / PER_PAYMENT_CAP - 1);
        assertEq(thief.refused(), 1, "the first payment over the cap was refused and the chain stopped");
    }

    function test_Token_WithReceiveHook_AnApprovalCannotBeUsedAgainInsideItsOwnPayment() public {
        HookToken token = new HookToken();
        ReentrantExecutor thief = new ReentrantExecutor();
        MandateVault other = new MandateVault(IERC20(address(token)), principal, IIdentityRegistry(address(registry)));
        vm.prank(principal);
        uint256 id = other.createMandate(
            agentId, address(thief), approver, new address[](0), 0, 0, HARD_CEILING, validUntil, TERMS_HASH
        );
        token.mint(address(other), 100 * USDC);

        bytes32 evidenceHash = keccak256("approved once");
        uint256 deadline = _now() + 1 hours;
        bytes memory signature =
            _sign(approverKey, other.approvalDigest(id, address(thief), 5 * USDC, evidenceHash, 0, deadline));
        bytes memory call = abi.encodeCall(
            MandateVault.payWithApproval, (id, address(thief), 5 * USDC, evidenceHash, deadline, signature)
        );
        thief.configure(other, id, 0, 0);
        thief.setApprovalCall(call);
        thief.run(call);

        assertTrue(thief.approvalReplayRefused(), "the second use, from inside the transfer, was refused");
        assertEq(token.balanceOf(address(thief)), 5 * USDC);
        assertEq(other.getMandate(id).approvalNonce, 1);
        assertEq(other.spentToday(id), 5 * USDC);
    }

    function test_Token_SentStraightToTheVault_BelongsToThePrincipalOnly() public {
        // Anyone can transfer tokens to the vault's address. That gives nobody a claim on them.
        usdc.mint(attacker, 5 * USDC);
        vm.prank(attacker);
        usdc.transfer(address(vault), 5 * USDC);

        vm.prank(attacker);
        vm.expectRevert(MandateVault.NotPrincipal.selector);
        vault.withdraw(5 * USDC);

        vm.prank(principal);
        vault.withdraw(VAULT_FUNDS + 5 * USDC);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }
}
