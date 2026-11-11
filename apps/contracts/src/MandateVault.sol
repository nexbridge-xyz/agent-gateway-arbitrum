// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title MandateVault
/// @notice Holds one principal's stablecoin and pays it out only under mandates the principal has set.
///
/// A mandate names an AI agent (by its ERC-8004 id), an executor that may submit the agent's payments, an
/// approver, a list of allowed payees, three limits and an expiry.
///
///  - Inside the mandate, the executor pays on its own: allowed payee, at most `perPaymentCap` per payment,
///    and at most `dailyCap` per UTC day.
///  - Outside the mandate, the executor needs the approver's EIP-712 signature for that exact payment.
///  - Even with an approval, a mandate never pays out more than `hardCeiling` in one UTC day.
///
/// The executor is the only role an offchain service holds. If that service is compromised, the limits above
/// are the most it can move. The principal can revoke a mandate or pause all payments at any time, and is the
/// only account that can withdraw.
///
/// @dev One vault serves one principal and one token. There is no upgrade path and no role besides the ones a
/// mandate names. The vault assumes a plain ERC-20 such as USDC: no transfer fees, no rebasing, no hooks.
///
/// Days are UTC days: `day = block.timestamp / 86400`, so counters reset at 00:00 UTC. On Arbitrum
/// `block.timestamp` is the sequencer's clock, which is reliable to well within the length of a day.
contract MandateVault is EIP712, Pausable {
    using SafeERC20 for IERC20;

    /// @notice The terms of one mandate. Terms never change after creation; a mandate can only be revoked.
    struct Mandate {
        uint256 agentId; // ERC-8004 id of the agent this mandate is for
        address executor; // may submit payments for this mandate
        uint64 validUntil; // last second (Unix time) at which the mandate can pay
        bool revoked;
        address approver; // signs approvals for payments outside the mandate (EOA or ERC-1271 account)
        uint256 perPaymentCap; // largest payment the executor can make on its own
        uint256 dailyCap; // most the mandate can pay per UTC day without an approval
        uint256 hardCeiling; // most the mandate can pay per UTC day in total, approvals included
        uint256 approvalNonce; // nonce the next approval must carry
        bytes32 termsHash; // hash of the plain-text mandate the principal approved
        address[] payees; // payees the executor can pay on its own
    }

    /// @notice EIP-712 type of the message an approver signs.
    bytes32 public constant PAYMENT_APPROVAL_TYPEHASH = keccak256(
        "PaymentApproval(uint256 mandateId,address payee,uint256 amount,bytes32 evidenceHash,uint256 nonce,uint256 deadline)"
    );

    /// @notice The token this vault holds and pays out (USDC).
    IERC20 public immutable token;

    /// @notice The owner of the vault and its funds.
    address public immutable principal;

    /// @notice The ERC-8004 Identity Registry that `agentId` values refer to.
    IIdentityRegistry public immutable identityRegistry;

    /// @notice Number of mandates created. Mandate ids run from 1 to `mandateCount`.
    uint256 public mandateCount;

    /// @notice Whether `payee` is on a mandate's allowlist.
    mapping(uint256 mandateId => mapping(address payee => bool allowed)) public isAllowedPayee;

    /// @notice Total a mandate paid out on a given UTC day, approved payments included.
    mapping(uint256 mandateId => mapping(uint256 day => uint256 amount)) public spentOnDay;

    /// @notice Whether an evidence hash has already anchored a payment. Each hash can be used once.
    mapping(bytes32 evidenceHash => bool used) public evidenceUsed;

    mapping(uint256 mandateId => Mandate mandate) private _mandates;

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event MandateCreated(
        uint256 indexed mandateId,
        uint256 indexed agentId,
        address indexed executor,
        address approver,
        address[] payees,
        uint256 perPaymentCap,
        uint256 dailyCap,
        uint256 hardCeiling,
        uint64 validUntil,
        bytes32 termsHash
    );
    event MandateRevoked(uint256 indexed mandateId, uint256 indexed agentId);

    /// @notice A payment inside the mandate. `evidenceHash` links it to the offchain evidence record.
    event MandatePayment(
        uint256 indexed mandateId, uint256 agentId, address indexed payee, uint256 amount, bytes32 indexed evidenceHash
    );

    /// @notice A payment outside the mandate, made with the approver's signature.
    event ApprovedPayment(
        uint256 indexed mandateId,
        uint256 agentId,
        address indexed payee,
        uint256 amount,
        bytes32 indexed evidenceHash,
        address approver,
        uint256 nonce
    );

    error NotPrincipal();
    error NotExecutor(uint256 mandateId, address caller);
    error ZeroAddress();
    error ZeroAmount();
    error ExecutorIsApprover();
    error InvalidCaps();
    error InvalidExpiry();
    error TermsHashRequired();
    error UnknownAgent(uint256 agentId);
    error DuplicatePayee(address payee);
    error UnknownMandate(uint256 mandateId);
    error MandateIsRevoked(uint256 mandateId);
    error MandateExpired(uint256 mandateId, uint64 validUntil);
    error PayeeNotAllowed(uint256 mandateId, address payee);
    error PerPaymentCapExceeded(uint256 amount, uint256 perPaymentCap);
    error DailyCapExceeded(uint256 dayTotal, uint256 dailyCap);
    error HardCeilingExceeded(uint256 dayTotal, uint256 hardCeiling);
    error ApprovalExpired(uint256 deadline);
    error InvalidApproval();
    error EvidenceRequired();
    error EvidenceAlreadyUsed(bytes32 evidenceHash);

    modifier onlyPrincipal() {
        if (msg.sender != principal) revert NotPrincipal();
        _;
    }

    /// @param token_ The token to hold and pay out.
    /// @param principal_ The owner of the vault. Cannot be changed later.
    /// @param identityRegistry_ The ERC-8004 Identity Registry on this chain.
    constructor(IERC20 token_, address principal_, IIdentityRegistry identityRegistry_) EIP712("MandateVault", "1") {
        if (address(token_) == address(0) || principal_ == address(0) || address(identityRegistry_) == address(0)) {
            revert ZeroAddress();
        }
        token = token_;
        principal = principal_;
        identityRegistry = identityRegistry_;
    }

    // ------------------------------------------------------------------------------------------------------
    // Principal: funds
    // ------------------------------------------------------------------------------------------------------

    /// @notice Move `amount` of the token from the principal into the vault. Needs a prior ERC-20 approval.
    function deposit(uint256 amount) external onlyPrincipal {
        if (amount == 0) revert ZeroAmount();
        emit Deposited(msg.sender, amount);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Return `amount` of the token to the principal. Works while paused.
    function withdraw(uint256 amount) external onlyPrincipal {
        if (amount == 0) revert ZeroAmount();
        emit Withdrawn(msg.sender, amount);
        token.safeTransfer(msg.sender, amount);
    }

    // ------------------------------------------------------------------------------------------------------
    // Principal: mandates
    // ------------------------------------------------------------------------------------------------------

    /// @notice Create a mandate for a registered agent.
    /// @param agentId The agent's id in the ERC-8004 Identity Registry. Must exist.
    /// @param executor The account that may submit this mandate's payments.
    /// @param approver The account whose signature unlocks payments outside the mandate. Must differ from
    /// `executor`, so that one key alone can never do both.
    /// @param payees The payees the executor can pay on its own.
    /// @param perPaymentCap Largest single payment without an approval.
    /// @param dailyCap Most the mandate pays per UTC day without an approval.
    /// @param hardCeiling Most the mandate pays per UTC day in total. No approval can lift it.
    /// @param validUntil Last second (Unix time) at which the mandate can pay.
    /// @param termsHash Hash of the plain-text mandate the principal approved.
    /// @return mandateId The id of the new mandate.
    function createMandate(
        uint256 agentId,
        address executor,
        address approver,
        address[] calldata payees,
        uint256 perPaymentCap,
        uint256 dailyCap,
        uint256 hardCeiling,
        uint64 validUntil,
        bytes32 termsHash
    ) external onlyPrincipal returns (uint256 mandateId) {
        if (executor == address(0) || approver == address(0)) revert ZeroAddress();
        if (executor == approver) revert ExecutorIsApprover();
        if (hardCeiling == 0 || perPaymentCap > dailyCap || dailyCap > hardCeiling) revert InvalidCaps();
        if (validUntil <= block.timestamp) revert InvalidExpiry();
        if (termsHash == bytes32(0)) revert TermsHashRequired();
        _requireRegisteredAgent(agentId);

        mandateId = ++mandateCount;
        Mandate storage m = _mandates[mandateId];
        m.agentId = agentId;
        m.executor = executor;
        m.validUntil = validUntil;
        m.approver = approver;
        m.perPaymentCap = perPaymentCap;
        m.dailyCap = dailyCap;
        m.hardCeiling = hardCeiling;
        m.termsHash = termsHash;
        m.payees = payees;

        for (uint256 i = 0; i < payees.length; ++i) {
            address payee = payees[i];
            if (payee == address(0)) revert ZeroAddress();
            if (isAllowedPayee[mandateId][payee]) revert DuplicatePayee(payee);
            isAllowedPayee[mandateId][payee] = true;
        }

        _emitMandateCreated(mandateId);
    }

    /// @notice Revoke a mandate. Takes effect at once and cannot be undone.
    function revokeMandate(uint256 mandateId) external onlyPrincipal {
        Mandate storage m = _mandates[mandateId];
        if (m.executor == address(0)) revert UnknownMandate(mandateId);
        if (m.revoked) revert MandateIsRevoked(mandateId);
        m.revoked = true;
        emit MandateRevoked(mandateId, m.agentId);
    }

    /// @notice Stop all mandate payments. Deposits, withdrawals and revocations keep working.
    function pause() external onlyPrincipal {
        _pause();
    }

    /// @notice Resume mandate payments.
    function unpause() external onlyPrincipal {
        _unpause();
    }

    // ------------------------------------------------------------------------------------------------------
    // Executor: payments
    // ------------------------------------------------------------------------------------------------------

    /// @notice Pay an allowed payee inside the mandate's limits. Only the mandate's executor can call this.
    /// @param evidenceHash keccak256 of the evidence record for this payment. Must be unused and non-zero.
    function payWithinMandate(uint256 mandateId, address payee, uint256 amount, bytes32 evidenceHash)
        external
        whenNotPaused
    {
        Mandate storage m = _mandates[mandateId];
        _requireExecutorOfLiveMandate(m, mandateId);
        if (!isAllowedPayee[mandateId][payee]) revert PayeeNotAllowed(mandateId, payee);
        if (amount == 0) revert ZeroAmount();
        if (amount > m.perPaymentCap) revert PerPaymentCapExceeded(amount, m.perPaymentCap);

        uint256 day = today();
        uint256 dayTotal = spentOnDay[mandateId][day] + amount;
        if (dayTotal > m.dailyCap) revert DailyCapExceeded(dayTotal, m.dailyCap);

        spentOnDay[mandateId][day] = dayTotal;
        _useEvidence(evidenceHash);
        emit MandatePayment(mandateId, m.agentId, payee, amount, evidenceHash);
        token.safeTransfer(payee, amount);
    }

    /// @notice Pay outside the mandate with the approver's signature. Only the mandate's executor can call
    /// this, so an approved payment always needs two keys: the executor's and the approver's.
    /// @dev The approver signs the EIP-712 message
    /// `PaymentApproval(mandateId, payee, amount, evidenceHash, nonce, deadline)`, where `nonce` is the
    /// mandate's current `approvalNonce`. Each approval works once. Any other approval signed for the same
    /// nonce stops working as soon as one of them is used.
    /// @param deadline Last second (Unix time) at which the approval can be used.
    /// @param signature The approver's signature: 65-byte ECDSA, or ERC-1271 data if the approver is a
    /// smart account.
    function payWithApproval(
        uint256 mandateId,
        address payee,
        uint256 amount,
        bytes32 evidenceHash,
        uint256 deadline,
        bytes calldata signature
    ) external whenNotPaused {
        Mandate storage m = _mandates[mandateId];
        _requireExecutorOfLiveMandate(m, mandateId);
        if (payee == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert ApprovalExpired(deadline);

        uint256 day = today();
        uint256 dayTotal = spentOnDay[mandateId][day] + amount;
        if (dayTotal > m.hardCeiling) revert HardCeilingExceeded(dayTotal, m.hardCeiling);

        uint256 nonce = m.approvalNonce;
        bytes32 digest = approvalDigest(mandateId, payee, amount, evidenceHash, nonce, deadline);
        if (!SignatureChecker.isValidSignatureNowCalldata(m.approver, digest, signature)) revert InvalidApproval();

        m.approvalNonce = nonce + 1;
        spentOnDay[mandateId][day] = dayTotal;
        _useEvidence(evidenceHash);
        // The only call made before this point is the read-only signature check, which cannot re-enter.
        // forge-lint: disable-next-line(reentrancy-events)
        emit ApprovedPayment(mandateId, m.agentId, payee, amount, evidenceHash, m.approver, nonce);
        token.safeTransfer(payee, amount);
    }

    // ------------------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------------------

    /// @notice The terms and state of a mandate.
    function getMandate(uint256 mandateId) external view returns (Mandate memory) {
        Mandate storage m = _mandates[mandateId];
        if (m.executor == address(0)) revert UnknownMandate(mandateId);
        return m;
    }

    /// @notice Whether a mandate exists, is not revoked and has not expired.
    function isActive(uint256 mandateId) external view returns (bool) {
        Mandate storage m = _mandates[mandateId];
        return m.executor != address(0) && !m.revoked && block.timestamp <= m.validUntil;
    }

    /// @notice Total the mandate has paid out in the current UTC day, approved payments included.
    function spentToday(uint256 mandateId) external view returns (uint256) {
        return spentOnDay[mandateId][today()];
    }

    /// @notice The current UTC day number: days since 1970-01-01.
    function today() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    /// @notice The EIP-712 digest an approver signs for a payment outside the mandate.
    function approvalDigest(
        uint256 mandateId,
        address payee,
        uint256 amount,
        bytes32 evidenceHash,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(PAYMENT_APPROVAL_TYPEHASH, mandateId, payee, amount, evidenceHash, nonce, deadline))
        );
    }

    // ------------------------------------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------------------------------------

    function _requireExecutorOfLiveMandate(Mandate storage m, uint256 mandateId) private view {
        if (msg.sender != m.executor) revert NotExecutor(mandateId, msg.sender);
        if (m.revoked) revert MandateIsRevoked(mandateId);
        if (block.timestamp > m.validUntil) revert MandateExpired(mandateId, m.validUntil);
    }

    function _requireRegisteredAgent(uint256 agentId) private view {
        try identityRegistry.ownerOf(agentId) returns (address owner) {
            if (owner == address(0)) revert UnknownAgent(agentId);
        } catch {
            revert UnknownAgent(agentId);
        }
    }

    function _useEvidence(bytes32 evidenceHash) private {
        if (evidenceHash == bytes32(0)) revert EvidenceRequired();
        if (evidenceUsed[evidenceHash]) revert EvidenceAlreadyUsed(evidenceHash);
        evidenceUsed[evidenceHash] = true;
    }

    /// @dev Reads the terms back from storage so that `createMandate` stays within the stack limit.
    function _emitMandateCreated(uint256 mandateId) private {
        Mandate storage m = _mandates[mandateId];
        emit MandateCreated(
            mandateId,
            m.agentId,
            m.executor,
            m.approver,
            m.payees,
            m.perPaymentCap,
            m.dailyCap,
            m.hardCeiling,
            m.validUntil,
            m.termsHash
        );
    }
}
