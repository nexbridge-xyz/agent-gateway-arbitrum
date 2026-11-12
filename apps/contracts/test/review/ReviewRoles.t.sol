// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MandateVault} from "../../src/MandateVault.sol";
import {MandateVaultBase} from "../MandateVaultBase.sol";

/// @notice Review: which roles of a mandate one address may hold, as the vault enforces it. SECURITY.md
/// describes exactly this; the test keeps the sentence and the contract together.
contract ReviewRolesTest is MandateVaultBase {
    /// The one pair the vault refuses: the executor as its own approver.
    function test_Roles_ExecutorCannotBeItsOwnApprover() public {
        Terms memory t = _terms();
        t.approver = executor;
        vm.expectRevert(MandateVault.ExecutorIsApprover.selector);
        _create(t);
    }

    /// The principal may name itself approver. It gains nothing by it: it can withdraw everything anyway.
    /// But it then holds two of the three roles with one key, and the vault does not object.
    function test_Roles_ThePrincipalMayBeTheApprover() public {
        Terms memory t = _terms();
        t.approver = principal;
        uint256 id = _create(t);
        assertEq(vault.getMandate(id).approver, principal);
    }

    /// The principal may name itself executor as well.
    function test_Roles_ThePrincipalMayBeTheExecutor() public {
        Terms memory t = _terms();
        t.executor = principal;
        uint256 id = _create(t);
        vm.prank(principal);
        vault.payWithinMandate(id, vendorA, 1 * USDC, _evidence());
        assertEq(usdc.balanceOf(vendorA), 1 * USDC);
    }
}
