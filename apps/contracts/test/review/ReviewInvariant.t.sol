// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MandateVault} from "../../src/MandateVault.sol";
import {MandateVaultBase} from "../MandateVaultBase.sol";
import {MockSmartAccount} from "../mocks/MockSmartAccount.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Review: a second invariant suite. The repository's own suite drives one mandate with one
/// executor. This one drives three mandates with two executors, a smart-account approver, revocations,
/// expiry, and an attacker who replays every signature and evidence hash the handler has ever produced.
contract ReviewHandler is Test {
    uint256 internal constant USDC = 1e6;

    struct Info {
        uint256 id;
        address executor;
        uint256 approverKey; // the key that signs, for a plain approver and for the smart account's owner
        uint256 perPaymentCap;
        uint256 dailyCap;
        uint256 hardCeiling;
        uint64 validUntil;
    }

    struct Used {
        uint256 mandate;
        address payee;
        uint256 amount;
        bytes32 evidenceHash;
        uint256 deadline;
        bytes signature;
    }

    MandateVault internal immutable vault;
    MockUSDC internal immutable usdc;
    address internal immutable principal;
    uint256 internal immutable outsiderKey;

    Info[] internal mandates;
    address[] internal recipients;
    Used[] internal usedApprovals;
    bytes32[] internal usedEvidence;

    // Ghost books.
    uint256 public deposited;
    uint256 public withdrawn;
    uint256 public paidOut;
    mapping(uint256 mandate => uint256 count) public approvedCount;
    mapping(uint256 mandate => mapping(uint256 day => uint256 amount)) public autoSpent;
    mapping(uint256 mandate => mapping(uint256 day => uint256 amount)) public totalSpent;
    mapping(uint256 mandate => bool revoked) public revoked;
    uint256[] internal _days;
    mapping(uint256 day => bool seen) internal _daySeen;

    // Things that must never happen. Each stays zero.
    uint256 public paidByWrongCaller;
    uint256 public paidOnDeadMandate;
    uint256 public paidOverPerPaymentCap;
    uint256 public paidToUnlistedWithoutApproval;
    uint256 public paidOnReplayedApproval;
    uint256 public paidOnReusedEvidence;
    uint256 public paidOnBadSignature;
    uint256 public paidWhilePaused;

    // How much of the interesting ground a run covered.
    uint256 public paymentsInside;
    uint256 public paymentsApproved;
    uint256 public replaysTried;
    uint256 public revocations;

    uint256 internal _evidenceCounter;

    constructor(
        MandateVault vault_,
        MockUSDC usdc_,
        address principal_,
        uint256 outsiderKey_,
        Info[] memory mandates_,
        address[] memory recipients_
    ) {
        vault = vault_;
        usdc = usdc_;
        principal = principal_;
        outsiderKey = outsiderKey_;
        for (uint256 i = 0; i < mandates_.length; ++i) {
            mandates.push(mandates_[i]);
        }
        recipients = recipients_;
        deposited = usdc_.balanceOf(address(vault_));
    }

    // --- Payments inside a mandate ------------------------------------------------------------------

    function payWithinMandate(uint256 mandateSeed, uint256 callerSeed, uint256 payeeSeed, uint256 amount) external {
        Info memory m = mandates[mandateSeed % mandates.length];
        address payee = recipients[payeeSeed % recipients.length];
        amount = bound(amount, 0, m.perPaymentCap + m.perPaymentCap / 10 + 1);
        // One call in four comes from the executor of another mandate.
        address caller =
            callerSeed % 4 == 0 ? mandates[(mandateSeed % mandates.length + 1) % mandates.length].executor : m.executor;
        bool listed = vault.isAllowedPayee(m.id, payee);
        bool dead = revoked[m.id] || _now() > m.validUntil;
        bool paused = vault.paused();

        vm.prank(caller);
        try vault.payWithinMandate(m.id, payee, amount, _evidence()) {
            _record(m.id, amount, false);
            if (caller != m.executor) paidByWrongCaller += amount;
            if (dead) paidOnDeadMandate += amount;
            if (amount > m.perPaymentCap) paidOverPerPaymentCap += amount;
            if (!listed) paidToUnlistedWithoutApproval += amount;
            if (paused) paidWhilePaused += amount;
        } catch {}
    }

    // --- Payments with an approval -------------------------------------------------------------------

    struct Attempt {
        uint256 id;
        address payee;
        uint256 amount;
        bytes32 evidenceHash;
        uint256 deadline;
        bytes signature;
        address caller;
        address rightCaller;
        bool badSigner;
        bool dead;
        bool paused;
    }

    function payWithApproval(uint256 mandateSeed, uint256 payeeSeed, uint256 amount, uint256 mode) external {
        Attempt memory a = _attempt(mandateSeed, payeeSeed, amount, mode);

        vm.prank(a.caller);
        try vault.payWithApproval(a.id, a.payee, a.amount, a.evidenceHash, a.deadline, a.signature) {
            _record(a.id, a.amount, true);
            usedApprovals.push(Used(a.id, a.payee, a.amount, a.evidenceHash, a.deadline, a.signature));
            usedEvidence.push(a.evidenceHash);
            if (a.badSigner) paidOnBadSignature += a.amount + 1;
            if (a.caller != a.rightCaller) paidByWrongCaller += a.amount + 1;
            if (a.dead) paidOnDeadMandate += a.amount + 1;
            if (a.paused) paidWhilePaused += a.amount + 1;
        } catch {}
    }

    /// Mostly modest approved payments by the right key; some above the ceiling, some signed by an
    /// outsider, some sent by the wrong executor, some with a deadline that is about to pass.
    function _attempt(uint256 mandateSeed, uint256 payeeSeed, uint256 amount, uint256 mode)
        private
        returns (Attempt memory a)
    {
        Info memory m = mandates[mandateSeed % mandates.length];
        a.id = m.id;
        a.payee = recipients[payeeSeed % recipients.length];
        a.amount = bound(amount, 0, mode % 9 == 0 ? m.hardCeiling + USDC : m.hardCeiling / 3);
        a.badSigner = mode % 5 == 0;
        a.evidenceHash = _evidence();
        a.deadline = _now() + (mode % 11 == 0 ? 0 : 1 hours);
        a.signature = _signFor(m, a);
        a.rightCaller = m.executor;
        a.caller = mode % 7 == 0 ? mandates[(mandateSeed % mandates.length + 1) % mandates.length].executor : m.executor;
        a.dead = revoked[m.id] || _now() > m.validUntil;
        a.paused = vault.paused();
    }

    function _signFor(Info memory m, Attempt memory a) private view returns (bytes memory) {
        uint256 nonce = vault.getMandate(m.id).approvalNonce;
        bytes32 digest = vault.approvalDigest(m.id, a.payee, a.amount, a.evidenceHash, nonce, a.deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(a.badSigner ? outsiderKey : m.approverKey, digest);
        return abi.encodePacked(r, s, v);
    }

    // --- Replays ------------------------------------------------------------------------------------

    /// Sends an approval that was already used: as it was, on another mandate, or with a fresh evidence hash.
    function replayApproval(uint256 index, uint256 mode) external {
        if (usedApprovals.length == 0) return;
        Used memory u = usedApprovals[index % usedApprovals.length];
        uint256 target = mode % 3 == 1 ? mandates[(index % mandates.length + 1) % mandates.length].id : u.mandate;
        bytes32 evidenceHash = mode % 3 == 2 ? _evidence() : u.evidenceHash;
        address caller = _executorOf(target);
        replaysTried += 1;

        vm.prank(caller);
        try vault.payWithApproval(target, u.payee, u.amount, evidenceHash, u.deadline, u.signature) {
            _record(target, u.amount, true);
            paidOnReplayedApproval += u.amount + 1;
        } catch {}
    }

    /// Cites an evidence hash a second time, on any mandate.
    function reuseEvidence(uint256 index, uint256 mandateSeed, uint256 payeeSeed) external {
        if (usedEvidence.length == 0) return;
        Info memory m = mandates[mandateSeed % mandates.length];
        address payee = recipients[payeeSeed % recipients.length];
        vm.prank(m.executor);
        try vault.payWithinMandate(m.id, payee, 1, usedEvidence[index % usedEvidence.length]) {
            _record(m.id, 1, false);
            paidOnReusedEvidence += 1;
        } catch {}
    }

    // --- The principal ------------------------------------------------------------------------------

    function revoke(uint256 mandateSeed, uint256 mode) external {
        // Rarely, so that most of a run still has live mandates.
        if (mode % 23 != 0) return;
        Info memory m = mandates[mandateSeed % mandates.length];
        if (revoked[m.id]) return;
        vm.prank(principal);
        vault.revokeMandate(m.id);
        revoked[m.id] = true;
        revocations += 1;
    }

    function setPaused(uint256 mode) external {
        bool paused = mode % 6 == 0;
        if (paused == vault.paused()) return;
        vm.prank(principal);
        if (paused) vault.pause();
        else vault.unpause();
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
        amount = bound(amount, 1, balance < 5 * USDC ? balance : 5 * USDC);
        vm.prank(principal);
        vault.withdraw(amount);
        withdrawn += amount;
    }

    function warp(uint256 secondsForward) external {
        skip(bound(secondsForward, 1, 9 hours));
    }

    // --- Views for the invariants -------------------------------------------------------------------

    function mandateCount() external view returns (uint256) {
        return mandates.length;
    }

    function mandateAt(uint256 index) external view returns (Info memory) {
        return mandates[index];
    }

    function dayCount() external view returns (uint256) {
        return _days.length;
    }

    function dayAt(uint256 index) external view returns (uint256) {
        return _days[index];
    }

    function _executorOf(uint256 id) private view returns (address) {
        for (uint256 i = 0; i < mandates.length; ++i) {
            if (mandates[i].id == id) return mandates[i].executor;
        }
        return address(0);
    }

    function _record(uint256 id, uint256 amount, bool approved) private {
        uint256 day = _now() / 1 days;
        if (!_daySeen[day]) {
            _daySeen[day] = true;
            _days.push(day);
        }
        totalSpent[id][day] += amount;
        if (approved) {
            approvedCount[id] += 1;
            paymentsApproved += 1;
        } else {
            autoSpent[id][day] += amount;
            paymentsInside += 1;
        }
        paidOut += amount;
    }

    function _evidence() private returns (bytes32) {
        return keccak256(abi.encode("review handler evidence", ++_evidenceCounter));
    }

    function _now() private view returns (uint256) {
        return vm.getBlockTimestamp();
    }
}

contract ReviewInvariantTest is MandateVaultBase {
    ReviewHandler internal handler;

    function setUp() public override {
        super.setUp();

        // Mandate 1 is the base fixture's: the demo's vendor mandate, plain approver.
        // Mandate 2: the demo's spend-wallet mandate, same executor, short-lived so that it expires mid-run.
        // Mandate 3: another executor, and a smart account as approver, owned by another key.
        address otherExecutor = makeAddr("otherExecutor");
        (address accountOwner, uint256 accountOwnerKey) = makeAddrAndKey("accountOwner");
        MockSmartAccount account = new MockSmartAccount(accountOwner);

        address[] memory spendOnly = new address[](1);
        spendOnly[0] = spendWallet;
        address[] memory vendors = new address[](2);
        vendors[0] = vendorA;
        vendors[1] = vendorB;

        vm.startPrank(principal);
        uint256 spendId = vault.createMandate(
            agentId, executor, approver, spendOnly, USDC / 2, USDC, USDC, uint64(START + 3 days), TERMS_HASH
        );
        uint256 thirdId = vault.createMandate(
            agentId, otherExecutor, address(account), vendors, 3 * USDC, 5 * USDC, 9 * USDC, validUntil, TERMS_HASH
        );
        vm.stopPrank();

        ReviewHandler.Info[] memory infos = new ReviewHandler.Info[](3);
        infos[0] =
            ReviewHandler.Info(mandateId, executor, approverKey, PER_PAYMENT_CAP, DAILY_CAP, HARD_CEILING, validUntil);
        infos[1] = ReviewHandler.Info(spendId, executor, approverKey, USDC / 2, USDC, USDC, uint64(START + 3 days));
        infos[2] = ReviewHandler.Info(thirdId, otherExecutor, accountOwnerKey, 3 * USDC, 5 * USDC, 9 * USDC, validUntil);

        address[] memory recipients = new address[](5);
        recipients[0] = spendWallet;
        recipients[1] = vendorA;
        recipients[2] = vendorB;
        recipients[3] = unlistedVendor;
        recipients[4] = attacker;

        handler = new ReviewHandler(vault, usdc, principal, attackerKey, infos, recipients);
        targetContract(address(handler));
    }

    /// Every mandate keeps its own limits on every UTC day, whatever the others do.
    function invariant_Review_EachMandateKeepsItsOwnLimits() public view {
        uint256 dayCount = handler.dayCount();
        for (uint256 i = 0; i < handler.mandateCount(); ++i) {
            ReviewHandler.Info memory m = handler.mandateAt(i);
            for (uint256 d = 0; d < dayCount; ++d) {
                uint256 day = handler.dayAt(d);
                assertLe(handler.autoSpent(m.id, day), m.dailyCap, "daily cap");
                assertLe(handler.totalSpent(m.id, day), m.hardCeiling, "hard ceiling");
                assertEq(vault.spentOnDay(m.id, day), handler.totalSpent(m.id, day), "the vault's count");
            }
            assertEq(vault.getMandate(m.id).approvalNonce, handler.approvedCount(m.id), "one nonce per approval");
        }
    }

    /// None of the things that must never happen has happened.
    function invariant_Review_NothingForbiddenWasPaid() public view {
        assertEq(handler.paidByWrongCaller(), 0, "paid for a caller who is not the mandate's executor");
        assertEq(handler.paidOnDeadMandate(), 0, "paid on a revoked or expired mandate");
        assertEq(handler.paidOverPerPaymentCap(), 0, "paid above the per-payment cap without approval");
        assertEq(handler.paidToUnlistedWithoutApproval(), 0, "paid an unlisted payee without approval");
        assertEq(handler.paidOnReplayedApproval(), 0, "paid on an approval that was used before");
        assertEq(handler.paidOnReusedEvidence(), 0, "paid twice on one evidence hash");
        assertEq(handler.paidOnBadSignature(), 0, "paid on a signature that is not the approver's");
        assertEq(handler.paidWhilePaused(), 0, "paid while the vault was paused");
    }

    /// Funds leave only through recorded payments and the principal's withdrawals.
    function invariant_Review_BalanceMatchesTheBooks() public view {
        assertEq(usdc.balanceOf(address(vault)), handler.deposited() - handler.withdrawn() - handler.paidOut());
    }

    /// Printed with -vv: how many payments, approvals, replays and revocations the last run made.
    function afterInvariant() public view {
        console2.log("payments inside a mandate:", handler.paymentsInside());
        console2.log("payments with an approval:", handler.paymentsApproved());
        console2.log("replays tried:", handler.replaysTried());
        console2.log("mandates revoked:", handler.revocations());
    }
}
