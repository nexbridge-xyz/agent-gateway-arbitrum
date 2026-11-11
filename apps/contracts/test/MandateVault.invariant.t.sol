// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MandateVault} from "../src/MandateVault.sol";
import {MandateVaultBase} from "./MandateVaultBase.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Drives the vault with random sequences of calls from every role and keeps its own books.
contract VaultHandler is Test {
    uint256 internal constant USDC = 1e6;

    MandateVault internal immutable vault;
    MockUSDC internal immutable usdc;
    uint256 internal immutable mandateId;
    address internal immutable principal;
    address internal immutable executor;
    uint256 internal immutable approverKey;
    uint256 internal immutable outsiderKey;

    /// Payees the handler pays: the mandate's allowlist followed by two addresses that are not on it.
    address[] internal recipients;

    // The handler's own books.
    uint256 public deposited;
    uint256 public withdrawn;
    uint256 public paidOut;
    uint256 public approvedPayments;
    uint256 public unlistedPaidWithoutApproval;
    uint256 public movedByOutsiders;
    uint256 public movedByBadApprovals;
    mapping(uint256 day => uint256 amount) public autoSpentOnDay;
    mapping(uint256 day => uint256 amount) public totalSpentOnDay;
    uint256[] internal _days;
    mapping(uint256 day => bool seen) internal _daySeen;

    uint256 internal _evidenceCounter;

    constructor(
        MandateVault vault_,
        MockUSDC usdc_,
        uint256 mandateId_,
        address principal_,
        address executor_,
        uint256 approverKey_,
        uint256 outsiderKey_,
        address[] memory recipients_
    ) {
        vault = vault_;
        usdc = usdc_;
        mandateId = mandateId_;
        principal = principal_;
        executor = executor_;
        approverKey = approverKey_;
        outsiderKey = outsiderKey_;
        recipients = recipients_;
        deposited = usdc_.balanceOf(address(vault_));
    }

    /// Mostly valid payments, with some unlisted payees and some amounts just over the per-payment cap.
    function payWithinMandate(uint256 recipientSeed, uint256 amount) external {
        address payee = recipients[recipientSeed % recipients.length];
        amount = bound(amount, 0, 2_200_000);
        bool listed = vault.isAllowedPayee(mandateId, payee);

        vm.prank(executor);
        try vault.payWithinMandate(mandateId, payee, amount, _evidence()) {
            _record(amount, false);
            if (!listed) unlistedPaidWithoutApproval += amount;
        } catch {}
    }

    /// Mostly modest approved payments, with some above the hard ceiling and some signed by the wrong key.
    function payWithApproval(uint256 recipientSeed, uint256 amount, uint256 mode) external {
        address payee = recipients[recipientSeed % recipients.length];
        amount = bound(amount, 0, mode % 7 == 0 ? 25 * USDC : 6 * USDC);
        bool signedByOutsider = mode % 5 == 0;
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        uint256 nonce = vault.getMandate(mandateId).approvalNonce;
        bytes32 digest = vault.approvalDigest(mandateId, payee, amount, evidenceHash, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signedByOutsider ? outsiderKey : approverKey, digest);

        vm.prank(executor);
        try vault.payWithApproval(mandateId, payee, amount, evidenceHash, deadline, abi.encodePacked(r, s, v)) {
            _record(amount, true);
            if (signedByOutsider) movedByBadApprovals += amount;
        } catch {}
    }

    /// Any account other than the executor and the principal tries to move funds.
    function outsiderTriesToMoveFunds(address caller, uint256 recipientSeed, uint256 amount) external {
        if (caller == executor || caller == principal) return;
        address payee = recipients[recipientSeed % recipients.length];
        amount = bound(amount, 1, 2 * USDC);
        uint256 balanceBefore = usdc.balanceOf(address(vault));

        vm.startPrank(caller);
        try vault.payWithinMandate(mandateId, payee, amount, _evidence()) {} catch {}
        try vault.withdraw(amount) {} catch {}
        try vault.revokeMandate(mandateId) {} catch {}
        vm.stopPrank();

        movedByOutsiders += balanceBefore - usdc.balanceOf(address(vault));
    }

    function deposit(uint256 amount) external {
        amount = bound(amount, 1, 50 * USDC);
        usdc.mint(principal, amount);
        vm.startPrank(principal);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
        deposited += amount;
    }

    function withdraw(uint256 amount) external {
        uint256 balance = usdc.balanceOf(address(vault));
        if (balance == 0) return;
        amount = bound(amount, 1, balance < 10 * USDC ? balance : 10 * USDC);
        vm.prank(principal);
        vault.withdraw(amount);
        withdrawn += amount;
    }

    /// Pauses now and then, and unpauses the rest of the time.
    function setPaused(uint256 mode) external {
        bool paused = mode % 6 == 0;
        if (paused == vault.paused()) return;
        vm.prank(principal);
        if (paused) vault.pause();
        else vault.unpause();
    }

    function warp(uint256 secondsForward) external {
        skip(bound(secondsForward, 1, 6 hours));
    }

    function dayCount() external view returns (uint256) {
        return _days.length;
    }

    function dayAt(uint256 index) external view returns (uint256) {
        return _days[index];
    }

    function _record(uint256 amount, bool approved) private {
        uint256 day = _now() / 1 days;
        if (!_daySeen[day]) {
            _daySeen[day] = true;
            _days.push(day);
        }
        totalSpentOnDay[day] += amount;
        if (approved) approvedPayments += 1;
        else autoSpentOnDay[day] += amount;
        paidOut += amount;
    }

    function _evidence() private returns (bytes32) {
        return keccak256(abi.encode("handler evidence", ++_evidenceCounter));
    }

    function _now() private view returns (uint256) {
        return vm.getBlockTimestamp();
    }
}

/// @notice Invariants: statements that must hold after any sequence of calls by any mix of roles.
contract MandateVaultInvariantTest is MandateVaultBase {
    VaultHandler internal handler;

    function setUp() public override {
        super.setUp();

        address[] memory recipients = new address[](5);
        recipients[0] = spendWallet;
        recipients[1] = vendorA;
        recipients[2] = vendorB;
        recipients[3] = unlistedVendor;
        recipients[4] = attacker;

        handler = new VaultHandler(vault, usdc, mandateId, principal, executor, approverKey, attackerKey, recipients);
        targetContract(address(handler));
    }

    /// Funds only leave through recorded payments and the principal's withdrawals.
    function invariant_VaultBalanceMatchesTheBooks() public view {
        assertEq(usdc.balanceOf(address(vault)), handler.deposited() - handler.withdrawn() - handler.paidOut());
    }

    /// On every UTC day: at most `dailyCap` without approval, and at most `hardCeiling` in total.
    function invariant_DailyLimitsHoldOnEveryDay() public view {
        uint256 count = handler.dayCount();
        for (uint256 i = 0; i < count; ++i) {
            uint256 day = handler.dayAt(i);
            assertLe(handler.autoSpentOnDay(day), DAILY_CAP);
            assertLe(handler.totalSpentOnDay(day), HARD_CEILING);
            assertEq(vault.spentOnDay(mandateId, day), handler.totalSpentOnDay(day));
        }
    }

    /// A payee outside the allowlist is never paid without the approver's signature.
    function invariant_UnlistedPayeesNeedAnApproval() public view {
        assertEq(handler.unlistedPaidWithoutApproval(), 0);
    }

    /// Only the approver's signature unlocks an approved payment, and each approval is counted once.
    function invariant_ApprovalsComeFromTheApproverAndCountOnce() public view {
        assertEq(handler.movedByBadApprovals(), 0);
        assertEq(vault.getMandate(mandateId).approvalNonce, handler.approvedPayments());
    }

    /// Accounts without a role never move funds or change a mandate.
    function invariant_OutsidersNeverMoveFunds() public view {
        assertEq(handler.movedByOutsiders(), 0);
        assertFalse(vault.getMandate(mandateId).revoked);
    }
}
