// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MandateVault} from "../src/MandateVault.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Shared fixture: a funded vault with one mandate that mirrors the demo
/// (2 USDC per payment, 8 USDC per day, 20 USDC hard ceiling, valid for 30 days).
abstract contract MandateVaultBase is Test {
    uint256 internal constant USDC = 1e6;
    uint256 internal constant PER_PAYMENT_CAP = 2 * USDC;
    uint256 internal constant DAILY_CAP = 8 * USDC;
    uint256 internal constant HARD_CEILING = 20 * USDC;
    uint256 internal constant VAULT_FUNDS = 100 * USDC;
    uint256 internal constant PRINCIPAL_FUNDS = 1_000 * USDC;
    uint64 internal constant MANDATE_DURATION = 30 days;
    bytes32 internal constant TERMS_HASH = keccak256("Demo mandate v1: research and procurement agent");

    /// 2026-11-13 03:00:00 UTC. Mid-morning, so a test only crosses midnight when it means to.
    uint256 internal constant START = 1_794_538_800;

    MockUSDC internal usdc;
    MockIdentityRegistry internal registry;
    MandateVault internal vault;

    address internal principal = makeAddr("principal");
    address internal executor = makeAddr("executor");
    address internal approver;
    uint256 internal approverKey;
    address internal agentOwner = makeAddr("agentOwner");
    address internal spendWallet = makeAddr("spendWallet");
    address internal vendorA = makeAddr("vendorA");
    address internal vendorB = makeAddr("vendorB");
    address internal unlistedVendor = makeAddr("unlistedVendor");
    address internal attacker;
    uint256 internal attackerKey;

    uint256 internal agentId;
    uint256 internal mandateId;
    uint64 internal validUntil;

    uint256 private _evidenceCounter;

    function setUp() public virtual {
        vm.warp(START);
        (approver, approverKey) = makeAddrAndKey("approver");
        (attacker, attackerKey) = makeAddrAndKey("attacker");

        usdc = new MockUSDC();
        registry = new MockIdentityRegistry();
        vault = new MandateVault(usdc, principal, IIdentityRegistry(address(registry)));

        vm.prank(agentOwner);
        agentId = registry.register();

        usdc.mint(principal, PRINCIPAL_FUNDS);
        validUntil = uint64(START) + MANDATE_DURATION;

        vm.startPrank(principal);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(VAULT_FUNDS);
        mandateId = vault.createMandate(
            agentId, executor, approver, _payees(), PER_PAYMENT_CAP, DAILY_CAP, HARD_CEILING, validUntil, TERMS_HASH
        );
        vm.stopPrank();
    }

    /// @dev The arguments of `createMandate`, so a test can change one term and keep the rest.
    struct Terms {
        uint256 agentId;
        address executor;
        address approver;
        address[] payees;
        uint256 perPaymentCap;
        uint256 dailyCap;
        uint256 hardCeiling;
        uint64 validUntil;
        bytes32 termsHash;
    }

    function _payees() internal view returns (address[] memory payees) {
        payees = new address[](3);
        payees[0] = spendWallet;
        payees[1] = vendorA;
        payees[2] = vendorB;
    }

    /// @dev The demo mandate's terms.
    function _terms() internal view returns (Terms memory) {
        return Terms({
            agentId: agentId,
            executor: executor,
            approver: approver,
            payees: _payees(),
            perPaymentCap: PER_PAYMENT_CAP,
            dailyCap: DAILY_CAP,
            hardCeiling: HARD_CEILING,
            validUntil: validUntil,
            termsHash: TERMS_HASH
        });
    }

    function _createAs(address caller, Terms memory t) internal returns (uint256) {
        vm.prank(caller);
        return vault.createMandate(
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
    }

    function _create(Terms memory t) internal returns (uint256) {
        return _createAs(principal, t);
    }

    /// @dev The current block time. Tests read it through the cheatcode, not `block.timestamp`, so the
    /// value is always fresh after `vm.warp` whatever the compiler settings.
    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    /// @dev A fresh evidence hash for every payment, as the gateway produces.
    function _evidence() internal returns (bytes32) {
        return keccak256(abi.encode("evidence", ++_evidenceCounter));
    }

    /// @dev Pays inside the mandate as the executor.
    function _pay(address payee, uint256 amount) internal returns (bytes32 evidenceHash) {
        evidenceHash = _evidence();
        vm.prank(executor);
        vault.payWithinMandate(mandateId, payee, amount, evidenceHash);
    }

    function _sign(uint256 signerKey, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Signs a payment approval for `vault` with `signerKey`.
    function _signApproval(
        uint256 signerKey,
        uint256 mandateId_,
        address payee,
        uint256 amount,
        bytes32 evidenceHash,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        return _sign(signerKey, vault.approvalDigest(mandateId_, payee, amount, evidenceHash, nonce, deadline));
    }

    /// @dev Has the approver sign for the mandate's current nonce, then pays as the executor.
    function _payApproved(address payee, uint256 amount) internal returns (bytes32 evidenceHash) {
        evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        uint256 nonce = vault.getMandate(mandateId).approvalNonce;
        bytes memory signature = _signApproval(approverKey, mandateId, payee, amount, evidenceHash, nonce, deadline);
        vm.prank(executor);
        vault.payWithApproval(mandateId, payee, amount, evidenceHash, deadline, signature);
    }
}
