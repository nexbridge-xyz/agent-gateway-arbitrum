// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MandateVault} from "../../src/MandateVault.sol";
import {DelegateThatConfirmsEverything, DelegateWithoutErc1271} from "../review/mocks/ReviewMocks.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Test} from "forge-std/Test.sol";

/// @dev The parts of Circle's FiatToken that these tests use.
interface IFiatToken is IERC20Metadata {
    function blacklister() external view returns (address);
    function blacklist(address account) external;
    function unBlacklist(address account) external;
    function isBlacklisted(address account) external view returns (bool);
    function pauser() external view returns (address);
    function pause() external;
    function unpause() external;
}

interface IRegistryView {
    function ownerOf(uint256 agentId) external view returns (address);
    function getAgentWallet(uint256 agentId) external view returns (address);
}

/// @notice Review: the DEPLOYED vault, with its real state, on a local fork of Arbitrum Sepolia.
///
/// Nothing here is sent to the live network. Start a fork and point the tests at it:
///
///   anvil --fork-url https://sepolia-rollup.arbitrum.io/rpc --port 8546 --hardfork prague
///   ARBITRUM_SEPOLIA_RPC_URL=http://127.0.0.1:8546 forge test --match-path 'test/fork/ReviewDeployed.fork.t.sol' -vv
///
/// forge-config: default.evm_version = "prague"
/// forge-config: ci.evm_version = "prague"
contract ReviewDeployedForkTest is Test {
    using stdJson for string;

    uint256 internal constant USDC = 1e6;

    // docs/sepolia-run: the recorded run's mandates and the approved payment of step 4, as written in
    // evidence/0x1c49838c6d8d52a6ff41684f6a463fa1b1a0914f9b9ccc31cd01ce4c721cb7d4.json.
    uint256 internal constant RECORDED_VENDOR_MANDATE = 3;
    uint256 internal constant RECORDED_SPEND_MANDATE = 4;
    address internal constant RECORDED_EXECUTOR = 0xB0aA521c777F8363DaA0446DD05807347d2f08B9;
    address internal constant RECORDED_APPROVER = 0x062Ac773F7470034411A7f739a5664F6B3cfcE69;
    address internal constant RECORDED_AGENT_WALLET = 0x277F7fcBEf2886A6b5F114DeeCaD52aaAE794B2a;
    address internal constant RECORDED_PAYEE = 0xDd76243f8563ea5D6E6186C0e26804F761A18792;
    uint256 internal constant RECORDED_AGENT_ID = 354;
    uint256 internal constant RECORDED_AMOUNT = 6_000_000;
    bytes32 internal constant RECORDED_EVIDENCE_HASH =
        0x0dab8c64d117ba5bbed56fc9e48d7244803a2659835c5934c8670b924f58362a;
    uint256 internal constant RECORDED_DEADLINE = 1_794_455_514;
    bytes internal constant RECORDED_SIGNATURE =
        hex"c2a46c8747b559e5d1c9a3abbf3937be0833e0fce8116898107a37b3a3ddd388690a479e7b47448d5f891e21d591333ce37ffcd77f135888e1c15feee5b332d51c";

    /// Storage slot of `_mandates` (forge inspect MandateVault storage-layout).
    uint256 internal constant MANDATES_SLOT = 7;
    /// Storage slot of `evidenceUsed`.
    uint256 internal constant EVIDENCE_USED_SLOT = 6;

    MandateVault internal vault;
    IFiatToken internal usdc;
    IRegistryView internal registry;
    address internal principal;
    bool internal forked;

    address internal executor = makeAddr("review executor");
    address internal approver;
    uint256 internal approverKey;
    address internal vendorA = makeAddr("review vendor A");
    address internal vendorB = makeAddr("review vendor B");
    address internal stranger = makeAddr("review stranger");

    uint256 private _evidenceCounter;

    function setUp() public {
        string memory rpcUrl = vm.envOr("ARBITRUM_SEPOLIA_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return;
        vm.createSelectFork(rpcUrl);
        forked = true;

        string memory record = vm.readFile("deployments/arbitrum-sepolia.json");
        vault = MandateVault(record.readAddress(".contracts.MandateVault.address"));
        usdc = IFiatToken(address(vault.token()));
        registry = IRegistryView(address(vault.identityRegistry()));
        principal = vault.principal();
        (approver, approverKey) = makeAddrAndKey("review approver");
    }

    modifier onlyOnFork() {
        if (!forked) vm.skip(true, "Set ARBITRUM_SEPOLIA_RPC_URL to a local fork to run fork tests");
        _;
    }

    function _evidence() internal returns (bytes32) {
        return keccak256(abi.encode("review fork evidence", ++_evidenceCounter));
    }

    /// @dev The principal (impersonated on the fork) creates a mandate like the demo's vendor mandate.
    function _newMandate(address approver_) internal returns (uint256 id) {
        address[] memory payees = new address[](2);
        payees[0] = vendorA;
        payees[1] = vendorB;
        vm.prank(principal);
        id = vault.createMandate(
            RECORDED_AGENT_ID,
            executor,
            approver_,
            payees,
            2 * USDC,
            8 * USDC,
            20 * USDC,
            uint64(block.timestamp + 30 days),
            keccak256("review mandate")
        );
        deal(address(usdc), address(vault), 100 * USDC);
    }

    function _mandateSlot(uint256 id, uint256 field) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(id, MANDATES_SLOT))) + field);
    }

    // ------------------------------------------------------------------------------------------------
    // The recorded run, as the chain holds it
    // ------------------------------------------------------------------------------------------------

    /// docs/sepolia-run says step 7 revoked both mandates of the run. Revocation cannot be undone, so this
    /// holds for good.
    function test_Fork_Review_TheRecordedRunsMandatesAreRevoked() public onlyOnFork {
        MandateVault.Mandate memory vendors = vault.getMandate(RECORDED_VENDOR_MANDATE);
        MandateVault.Mandate memory spend = vault.getMandate(RECORDED_SPEND_MANDATE);
        assertTrue(vendors.revoked);
        assertTrue(spend.revoked);
        assertFalse(vault.isActive(RECORDED_VENDOR_MANDATE));
        assertFalse(vault.isActive(RECORDED_SPEND_MANDATE));

        // And they are what the documents say they were.
        assertEq(vendors.agentId, RECORDED_AGENT_ID);
        assertEq(vendors.executor, RECORDED_EXECUTOR);
        assertEq(vendors.approver, RECORDED_APPROVER);
        assertEq(vendors.perPaymentCap, 2 * USDC);
        assertEq(vendors.dailyCap, 8 * USDC);
        assertEq(vendors.hardCeiling, 20 * USDC);
        assertEq(vendors.payees.length, 2);
        assertEq(vendors.approvalNonce, 1, "one approved payment was made");
        assertEq(spend.perPaymentCap, USDC / 2);
        assertEq(spend.dailyCap, 1 * USDC);
        assertEq(spend.hardCeiling, 1 * USDC);
        assertEq(spend.payees.length, 1);
        // The spend wallet is on its own mandate and not on the vendor mandate.
        assertFalse(vault.isAllowedPayee(RECORDED_VENDOR_MANDATE, spend.payees[0]));
        assertTrue(vault.evidenceUsed(RECORDED_EVIDENCE_HASH));
    }

    /// The live state at the time of this review, printed with -vv. Mandates created after the recorded
    /// run show up here.
    function test_Fork_Review_PrintLiveMandates() public onlyOnFork {
        uint256 count = vault.mandateCount();
        emit log_named_uint("mandates in the vault", count);
        emit log_named_decimal_uint("USDC in the vault", usdc.balanceOf(address(vault)), 6);
        for (uint256 id = 1; id <= count; ++id) {
            MandateVault.Mandate memory m = vault.getMandate(id);
            emit log_named_uint("mandate", id);
            emit log_named_string("  state", m.revoked ? "revoked" : vault.isActive(id) ? "ACTIVE" : "expired");
            emit log_named_address("  executor", m.executor);
            emit log_named_address("  approver", m.approver);
            emit log_named_decimal_uint("  hard ceiling", m.hardCeiling, 6);
            emit log_named_decimal_uint("  paid today", vault.spentToday(id), 6);
        }
    }

    /// The approval of step 4 is public: its signature is in the repository. It must be worthless now.
    /// Four things stand between it and a second payment, and each is enough on its own. The test takes
    /// them away one at a time (by writing to the fork's storage, which nobody can do onchain) and
    /// shows the next one holding.
    function test_Fork_Review_TheRecordedApprovalCannotBeReplayed_FourTimesOver() public onlyOnFork {
        deal(address(usdc), address(vault), 50 * USDC);

        // 1. As the chain is: the mandate is revoked.
        vm.prank(RECORDED_EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.MandateIsRevoked.selector, RECORDED_VENDOR_MANDATE));
        _replayRecordedApproval();

        // Suppose it had not been revoked. (executor, validUntil and revoked share one slot.)
        bytes32 packed = vm.load(address(vault), _mandateSlot(RECORDED_VENDOR_MANDATE, 1));
        vm.store(address(vault), _mandateSlot(RECORDED_VENDOR_MANDATE, 1), packed & ~bytes32(uint256(0xff) << 224));
        assertFalse(vault.getMandate(RECORDED_VENDOR_MANDATE).revoked);

        // 2. The deadline has passed.
        vm.prank(RECORDED_EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.ApprovalExpired.selector, RECORDED_DEADLINE));
        _replayRecordedApproval();

        // Suppose it were still the last second of the signing window.
        vm.warp(RECORDED_DEADLINE);

        // 3. The approval number has moved on: the signature was for number 0, the mandate is at 1.
        vm.prank(RECORDED_EXECUTOR);
        vm.expectRevert(MandateVault.InvalidApproval.selector);
        _replayRecordedApproval();

        // Suppose the number were 0 again.
        vm.store(address(vault), _mandateSlot(RECORDED_VENDOR_MANDATE, 6), bytes32(0));

        // 4. The evidence hash has been used.
        vm.prank(RECORDED_EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.EvidenceAlreadyUsed.selector, RECORDED_EVIDENCE_HASH));
        _replayRecordedApproval();

        // With all four taken away the payment goes through: the recorded signature really is the
        // approver's, for this vault, this payee and this amount. So the four refusals above were about
        // this approval, not about a malformed call.
        vm.store(address(vault), keccak256(abi.encode(RECORDED_EVIDENCE_HASH, EVIDENCE_USED_SLOT)), bytes32(0));
        uint256 before = usdc.balanceOf(RECORDED_PAYEE);
        vm.prank(RECORDED_EXECUTOR);
        _replayRecordedApproval();
        assertEq(usdc.balanceOf(RECORDED_PAYEE) - before, RECORDED_AMOUNT);
    }

    function _replayRecordedApproval() internal {
        vault.payWithApproval(
            RECORDED_VENDOR_MANDATE,
            RECORDED_PAYEE,
            RECORDED_AMOUNT,
            RECORDED_EVIDENCE_HASH,
            RECORDED_DEADLINE,
            RECORDED_SIGNATURE
        );
    }

    /// The recorded approval is for mandate 3. It cannot be moved to another mandate with the same
    /// approver, executor, payee list and approval number 0.
    function test_Fork_Review_TheRecordedApproval_DoesNotFitANewMandateWithTheSameApprover() public onlyOnFork {
        address[] memory payees = new address[](1);
        payees[0] = RECORDED_PAYEE;
        vm.prank(principal);
        uint256 id = vault.createMandate(
            RECORDED_AGENT_ID,
            RECORDED_EXECUTOR,
            RECORDED_APPROVER,
            payees,
            2 * USDC,
            8 * USDC,
            20 * USDC,
            uint64(block.timestamp + 30 days),
            keccak256("review mandate")
        );
        deal(address(usdc), address(vault), 50 * USDC);
        vm.warp(RECORDED_DEADLINE);
        // A fresh evidence hash would not match the signature either, so the recorded one is "freed".
        vm.store(address(vault), keccak256(abi.encode(RECORDED_EVIDENCE_HASH, EVIDENCE_USED_SLOT)), bytes32(0));

        vm.prank(RECORDED_EXECUTOR);
        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vault.payWithApproval(
            id, RECORDED_PAYEE, RECORDED_AMOUNT, RECORDED_EVIDENCE_HASH, RECORDED_DEADLINE, RECORDED_SIGNATURE
        );
    }

    // ------------------------------------------------------------------------------------------------
    // The identity registry the vault and the gateway rely on
    // ------------------------------------------------------------------------------------------------

    function test_Fork_Review_Agent354IsOwnedByThePrincipalAndSignsWithTheAgentKey() public onlyOnFork {
        assertEq(registry.ownerOf(RECORDED_AGENT_ID), principal);
        assertEq(registry.getAgentWallet(RECORDED_AGENT_ID), RECORDED_AGENT_WALLET);
    }

    /// The registry is an upgradeable proxy. Whoever can upgrade it can change which wallet "is" an
    /// agent. That cannot move money outside a mandate, but it is a party the gateway trusts for who is
    /// asking. Printed with -vv.
    function test_Fork_Review_TheRegistryIsAnUpgradeableProxy() public onlyOnFork {
        bytes32 implementationSlot = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
        address implementation = address(uint160(uint256(vm.load(address(registry), implementationSlot))));
        emit log_named_address("ERC-1967 implementation behind the identity registry", implementation);
        assertTrue(implementation != address(0), "the registry is a proxy with an implementation slot");
        assertGt(implementation.code.length, 0);
    }

    // ------------------------------------------------------------------------------------------------
    // Circle's USDC as it really behaves
    // ------------------------------------------------------------------------------------------------

    function test_Fork_Review_LiveUsdc_ABlockedPayeeStopsOnlyItsOwnPayments() public onlyOnFork {
        uint256 id = _newMandate(approver);
        vm.prank(usdc.blacklister());
        usdc.blacklist(vendorA);

        bytes32 evidenceHash = _evidence();
        vm.prank(executor);
        vm.expectRevert();
        vault.payWithinMandate(id, vendorA, 1 * USDC, evidenceHash);
        assertEq(vault.spentToday(id), 0, "a refused transfer counts for nothing");
        assertFalse(vault.evidenceUsed(evidenceHash));

        vm.prank(executor);
        vault.payWithinMandate(id, vendorB, 1 * USDC, evidenceHash);
        assertEq(usdc.balanceOf(vendorB), 1 * USDC);
    }

    function test_Fork_Review_LiveUsdc_PausedOrVaultBlocked_NothingMovesAndNothingIsLost() public onlyOnFork {
        uint256 id = _newMandate(approver);
        uint256 held = usdc.balanceOf(address(vault));

        vm.prank(usdc.pauser());
        usdc.pause();
        vm.prank(executor);
        vm.expectRevert();
        vault.payWithinMandate(id, vendorA, 1 * USDC, _evidence());
        vm.prank(principal);
        vm.expectRevert();
        vault.withdraw(1 * USDC);
        vm.prank(usdc.pauser());
        usdc.unpause();

        vm.prank(usdc.blacklister());
        usdc.blacklist(address(vault));
        vm.prank(principal);
        vm.expectRevert();
        vault.withdraw(1 * USDC);
        vm.prank(usdc.blacklister());
        usdc.unBlacklist(address(vault));

        assertEq(usdc.balanceOf(address(vault)), held);
        vm.prank(principal);
        vault.withdraw(held);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    // ------------------------------------------------------------------------------------------------
    // The deployed bytecode, roles and limits, with the real token
    // ------------------------------------------------------------------------------------------------

    function test_Fork_Review_DeployedVault_AStolenExecutorKeyIsBoundByTheMandate() public onlyOnFork {
        uint256 id = _newMandate(approver);

        vm.startPrank(executor);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.PayeeNotAllowed.selector, id, stranger));
        vault.payWithinMandate(id, stranger, 1 * USDC, _evidence());

        vm.expectRevert(abi.encodeWithSelector(MandateVault.PerPaymentCapExceeded.selector, 2 * USDC + 1, 2 * USDC));
        vault.payWithinMandate(id, vendorA, 2 * USDC + 1, _evidence());

        for (uint256 i = 0; i < 4; ++i) {
            vault.payWithinMandate(id, vendorA, 2 * USDC, _evidence());
        }
        vm.expectRevert(abi.encodeWithSelector(MandateVault.DailyCapExceeded.selector, 8 * USDC + 1, 8 * USDC));
        vault.payWithinMandate(id, vendorA, 1, _evidence());

        vm.expectRevert(MandateVault.NotPrincipal.selector);
        vault.withdraw(1);
        vm.stopPrank();

        // The executor signs an approval itself.
        (, uint256 someKey) = makeAddrAndKey("not the approver");
        bytes32 evidenceHash = _evidence();
        uint256 deadline = block.timestamp + 600;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(someKey, vault.approvalDigest(id, stranger, 9 * USDC, evidenceHash, 0, deadline));
        vm.prank(executor);
        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vault.payWithApproval(id, stranger, 9 * USDC, evidenceHash, deadline, abi.encodePacked(r, s, v));

        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(usdc.balanceOf(vendorA), 8 * USDC);
    }

    function test_Fork_Review_DeployedVault_RevokeAndPauseTakeEffectAtOnce() public onlyOnFork {
        uint256 id = _newMandate(approver);
        bytes32 evidenceHash = _evidence();
        uint256 deadline = block.timestamp + 600;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(approverKey, vault.approvalDigest(id, stranger, 5 * USDC, evidenceHash, 0, deadline));
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.prank(principal);
        vault.pause();
        vm.prank(executor);
        vm.expectRevert();
        vault.payWithApproval(id, stranger, 5 * USDC, evidenceHash, deadline, signature);
        vm.prank(principal);
        vault.unpause();

        vm.prank(principal);
        vault.revokeMandate(id);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.MandateIsRevoked.selector, id));
        vault.payWithApproval(id, stranger, 5 * USDC, evidenceHash, deadline, signature);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.MandateIsRevoked.selector, id));
        vault.payWithinMandate(id, vendorA, 1 * USDC, _evidence());
        assertEq(usdc.balanceOf(stranger), 0);
    }

    // ------------------------------------------------------------------------------------------------
    // EIP-7702 on the deployed bytecode
    // ------------------------------------------------------------------------------------------------

    function test_Fork_Review_DeployedVault_AnApproverKeyWithADelegationIsAskedThroughItsCode() public onlyOnFork {
        uint256 id = _newMandate(approver);
        bytes32 evidenceHash = _evidence();
        uint256 deadline = block.timestamp + 600;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(approverKey, vault.approvalDigest(id, stranger, 5 * USDC, evidenceHash, 0, deadline));
        bytes memory signature = abi.encodePacked(r, s, v);

        // The approver's key delegates to wallet code without ERC-1271: its signature stops counting.
        vm.signAndAttachDelegation(address(new DelegateWithoutErc1271()), approverKey);
        vault.today();
        assertEq(approver.code.length, 23);
        vm.prank(executor);
        vm.expectRevert(MandateVault.InvalidApproval.selector);
        vault.payWithApproval(id, stranger, 5 * USDC, evidenceHash, deadline, signature);

        // The key delegates to code that confirms everything: the executor needs no signature any more.
        vm.signAndAttachDelegation(address(new DelegateThatConfirmsEverything()), approverKey);
        vault.today();
        vm.prank(executor);
        vault.payWithApproval(id, stranger, 20 * USDC, _evidence(), block.timestamp + 1, hex"");
        assertEq(usdc.balanceOf(stranger), 20 * USDC, "the hard ceiling, to any address, with one key");
    }
}
