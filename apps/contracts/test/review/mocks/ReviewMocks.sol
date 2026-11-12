// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MandateVault} from "../../../src/MandateVault.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

// ----------------------------------------------------------------------------------------------------
// Code an approver's key can delegate to with EIP-7702
// ----------------------------------------------------------------------------------------------------

/// @notice A wallet implementation that speaks ERC-1271 and accepts the signature of the key whose
/// account runs it. With an EIP-7702 delegation `address(this)` is the key's own address.
contract DelegateWithErc1271 is IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == address(this)) {
            return IERC1271.isValidSignature.selector;
        }
        return 0xffffffff;
    }
}

/// @notice A wallet implementation that batches calls and knows nothing about ERC-1271, as many do.
contract DelegateWithoutErc1271 {
    function execute(address target, bytes calldata data) external payable returns (bytes memory result) {
        require(msg.sender == address(this), "only the account itself");
        bool ok;
        (ok, result) = target.call{value: msg.value}(data);
        require(ok, "call failed");
    }
}

/// @notice Code that confirms every signature. Nobody should delegate to this; somebody might be tricked to.
contract DelegateThatConfirmsEverything {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return IERC1271.isValidSignature.selector;
    }
}

// ----------------------------------------------------------------------------------------------------
// Approver contracts that answer ERC-1271 in unusual ways
// ----------------------------------------------------------------------------------------------------

contract ApproverThatReverts {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        revert("no");
    }
}

contract ApproverWithWrongMagic {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x1626ba7f;
    }
}

/// @dev Returns nothing at all, like a contract whose fallback accepts any call.
contract ApproverThatReturnsNothing {
    fallback() external {}
}

/// @dev The right four bytes, followed by bytes that are not zero. A strict ABI reader refuses this.
contract ApproverWithDirtyMagic {
    fallback() external {
        assembly {
            mstore(0x00, 0x1626ba7e00000000000000000000000000000000000000000000000000000001)
            return(0x00, 0x20)
        }
    }
}

/// @dev The right word, followed by a second word. Still a valid answer for a caller that reads one word.
contract ApproverWithLongAnswer {
    fallback() external {
        assembly {
            mstore(0x00, 0x1626ba7e00000000000000000000000000000000000000000000000000000000)
            mstore(0x20, 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff)
            return(0x00, 0x40)
        }
    }
}

/// @dev Only 31 bytes of answer: too short to be a word.
contract ApproverWithShortAnswer {
    fallback() external {
        assembly {
            mstore(0x00, 0x1626ba7e00000000000000000000000000000000000000000000000000000000)
            return(0x00, 0x1f)
        }
    }
}

contract ApproverThatBurnsAllGas {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        uint256 i;
        while (true) {
            unchecked {
                ++i;
            }
        }
        return IERC1271.isValidSignature.selector;
    }
}

/// @dev Tries to write state while it is asked. The vault asks with a static call, so this must fail.
contract ApproverThatWritesState {
    uint256 public asked;

    function isValidSignature(bytes32, bytes calldata) external returns (bytes4) {
        asked += 1;
        return IERC1271.isValidSignature.selector;
    }
}

// ----------------------------------------------------------------------------------------------------
// Tokens that are not plain ERC-20
// ----------------------------------------------------------------------------------------------------

/// @notice Takes 1% of every transfer.
contract FeeToken is ERC20 {
    address public constant FEE_SINK = address(0xFEE);

    constructor() ERC20("Fee Token", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = value / 100;
        super._update(from, FEE_SINK, fee);
        super._update(from, to, value - fee);
    }
}

/// @notice Returns nothing from transfer and transferFrom, like USDT on Ethereum.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @notice Returns false instead of reverting when a transfer is not made.
contract FalseReturnToken {
    mapping(address => uint256) public balanceOf;
    bool public refuse;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setRefuse(bool value) external {
        refuse = value;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (refuse || balanceOf[msg.sender] < amount) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice Blocks chosen addresses, as USDC's issuer can.
contract BlocklistToken is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Blocklist Token", "BLK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who, bool value) external {
        blocked[who] = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "blocked");
        super._update(from, to, value);
    }
}

interface ITokenReceiver {
    function onTokenReceived(address from, uint256 amount) external;
}

/// @notice Calls the recipient after every transfer, like an ERC-777 token. The vault says it does not
/// support such tokens; these tests show what happens if one is used anyway.
contract HookToken is ERC20 {
    constructor() ERC20("Hook Token", "HOOK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && to.code.length > 0) {
            ITokenReceiver(to).onTokenReceived(from, value);
        }
    }
}

/// @notice An executor that is also a payee and calls the vault again while it is being paid.
contract ReentrantExecutor is ITokenReceiver {
    MandateVault public vault;
    uint256 public mandateId;
    uint256 public amount;
    uint256 public attempts;
    uint256 public reentered;
    uint256 public refused;
    uint256 public maxAttempts;

    // What to replay inside the hook, for the approval test.
    bytes public approvalCall;
    bool public approvalReplayRefused;

    function configure(MandateVault vault_, uint256 mandateId_, uint256 amount_, uint256 maxAttempts_) external {
        vault = vault_;
        mandateId = mandateId_;
        amount = amount_;
        maxAttempts = maxAttempts_;
    }

    function setApprovalCall(bytes calldata data) external {
        approvalCall = data;
    }

    function pay(bytes32 evidenceHash) external {
        vault.payWithinMandate(mandateId, address(this), amount, evidenceHash);
    }

    function run(bytes calldata data) external {
        (bool ok, bytes memory result) = address(vault).call(data);
        if (!ok) {
            assembly {
                revert(add(result, 0x20), mload(result))
            }
        }
    }

    function onTokenReceived(address, uint256) external {
        if (approvalCall.length > 0) {
            // The same approved payment again, from inside its own transfer.
            (bool ok,) = address(vault).call(approvalCall);
            approvalReplayRefused = !ok;
            return;
        }
        if (attempts >= maxAttempts) return;
        attempts += 1;
        try vault.payWithinMandate(
            mandateId, address(this), amount, keccak256(abi.encode("reentrant evidence", attempts))
        ) {
            reentered += 1;
        } catch {
            refused += 1;
        }
    }
}

/// @notice A contract the executor's key calls. It tries to pay in the executor's name.
contract Forwarder {
    function forward(address target, bytes calldata data) external returns (bool ok, bytes memory result) {
        (ok, result) = target.call(data);
    }
}
