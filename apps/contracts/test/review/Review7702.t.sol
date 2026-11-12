// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MandateVault} from "../../src/MandateVault.sol";
import {MandateVaultBase} from "../MandateVaultBase.sol";
import {DelegateThatConfirmsEverything, DelegateWithErc1271, DelegateWithoutErc1271} from "./mocks/ReviewMocks.sol";

/// @notice Review: an approver whose key carries an EIP-7702 delegation.
///
/// With a delegation the approver's address has code (23 bytes: 0xef0100 and the delegate's address), so
/// the vault no longer checks the key's signature. It asks the delegate's code through ERC-1271 instead.
/// Arbitrum has had EIP-7702 since ArbOS 40, so this can happen to the deployed vault.
///
/// These tests run on the Prague EVM. The repository's default is Cancun, where a delegation cannot exist.
/// forge-config: default.evm_version = "prague"
/// forge-config: ci.evm_version = "prague"
contract Review7702Test is MandateVaultBase {
    uint256 internal constant AMOUNT = 6 * 1e6;

    function _delegate(address delegate) internal {
        vm.signAndAttachDelegation(delegate, approverKey);
        // The delegation is written by the next call of any kind.
        vault.today();
        assertEq(approver.code.length, 23, "the approver's address now has code");
    }

    function _approvalBy(uint256 key, bytes32 evidenceHash, uint256 deadline) internal view returns (bytes memory) {
        return _signApproval(key, mandateId, unlistedVendor, AMOUNT, evidenceHash, 0, deadline);
    }

    /// A delegation to wallet code that does not speak ERC-1271 switches the approver off: the key's own,
    /// perfectly good signature is refused. SECURITY.md says so; this is the test for it.
    function test_7702_DelegateWithoutErc1271_TheKeysSignatureNoLongerCounts() public {
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _approvalBy(approverKey, evidenceHash, deadline);

        _delegate(address(new DelegateWithoutErc1271()));

        vm.prank(executor);
        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vault.payWithApproval(mandateId, unlistedVendor, AMOUNT, evidenceHash, deadline, signature);
        assertEq(vault.getMandate(mandateId).approvalNonce, 0);
    }

    /// The same signature works again once the delegation is cleared, if its deadline has not passed.
    /// An approval that was "refused" while the key was delegated is therefore not dead.
    function test_7702_ClearingTheDelegation_BringsTheOldSignatureBack() public {
        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _approvalBy(approverKey, evidenceHash, deadline);

        _delegate(address(new DelegateWithoutErc1271()));
        vm.prank(executor);
        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vault.payWithApproval(mandateId, unlistedVendor, AMOUNT, evidenceHash, deadline, signature);

        // Delegating to the zero address removes the code.
        vm.signAndAttachDelegation(address(0), approverKey);
        vault.today();
        assertEq(approver.code.length, 0);

        vm.prank(executor);
        vault.payWithApproval(mandateId, unlistedVendor, AMOUNT, evidenceHash, deadline, signature);
        assertEq(usdc.balanceOf(unlistedVendor), AMOUNT);
    }

    /// A delegate that speaks ERC-1271 and checks the account's own key keeps the approver working.
    function test_7702_DelegateWithErc1271_TheKeysSignatureIsAccepted() public {
        _delegate(address(new DelegateWithErc1271()));

        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _approvalBy(approverKey, evidenceHash, deadline);
        vm.prank(executor);
        vault.payWithApproval(mandateId, unlistedVendor, AMOUNT, evidenceHash, deadline, signature);
        assertEq(usdc.balanceOf(unlistedVendor), AMOUNT);
    }

    /// And it still refuses everybody else's signature.
    function test_7702_DelegateWithErc1271_StillRefusesAnotherKey() public {
        _delegate(address(new DelegateWithErc1271()));

        bytes32 evidenceHash = _evidence();
        uint256 deadline = _now() + 1 hours;
        bytes memory signature = _approvalBy(attackerKey, evidenceHash, deadline);
        vm.prank(executor);
        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vault.payWithApproval(mandateId, unlistedVendor, AMOUNT, evidenceHash, deadline, signature);
    }

    /// The two-key rule is only as strong as the code the approver's key delegates to. If the approver is
    /// tricked into delegating to code that confirms everything, the executor alone can pay any address up
    /// to the hard ceiling, every day, with no signature at all. This is the outer bound of what a stolen
    /// executor key is worth when the approver's key is used carelessly: the hard ceiling, not the caps.
    function test_7702_DelegateThatConfirmsEverything_TheExecutorAloneReachesTheHardCeiling() public {
        _delegate(address(new DelegateThatConfirmsEverything()));

        vm.prank(executor);
        vault.payWithApproval(mandateId, attacker, HARD_CEILING, _evidence(), _now() + 1, hex"");
        assertEq(usdc.balanceOf(attacker), HARD_CEILING);

        // The ceiling itself still holds.
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(MandateVault.HardCeilingExceeded.selector, HARD_CEILING + 1, HARD_CEILING)
        );
        vault.payWithApproval(mandateId, attacker, 1, _evidence(), _now() + 1, hex"");
    }

    /// A delegation on the executor's key changes nothing about who may pay: the vault still looks at
    /// the caller's address.
    function test_7702_DelegationOnTheExecutor_DoesNotWidenWhoMayPay() public {
        (address delegatedExecutor, uint256 delegatedExecutorKey) = makeAddrAndKey("delegatedExecutor");
        Terms memory t = _terms();
        t.executor = delegatedExecutor;
        uint256 id = _create(t);

        vm.signAndAttachDelegation(address(new DelegateWithoutErc1271()), delegatedExecutorKey);
        vault.today();
        assertGt(delegatedExecutor.code.length, 0);

        vm.prank(delegatedExecutor);
        vault.payWithinMandate(id, vendorA, 1e6, _evidence());

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.NotExecutor.selector, id, attacker));
        vault.payWithinMandate(id, vendorA, 1e6, _evidence());
    }
}
