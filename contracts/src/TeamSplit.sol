// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/// @title TeamSplit
/// @notice One HSP payment, paid out to a whole team of agents.
///
/// HSP orders have a single `pay_to`. Real agent work is often done by a team: a lead agent
/// takes the job and brings in specialists. TeamSplit gives every job its own payment address
/// that *is* the team's agreement:
///
///   address = CREATE2(factory, ref, keccak256(Split code ‖ payees ‖ shares))
///
/// Change one payee or one share and the address changes, so the paying agent can check the split
/// before it pays, and nobody can alter it afterwards. The address can receive HSP payments
/// before any contract exists there; `settle` deploys it (if needed) and pays every member their
/// share in the same transaction.
///
/// No owner, no admin, no fees, no upgrades. Funds can only ever go to the agreed payees.
contract TeamSplitFactory {
    uint256 public constant MAX_PAYEES = 10;
    uint16 public constant TOTAL_BPS = 10_000;

    event SplitDeployed(address indexed split, bytes32 indexed ref, address[] payees, uint16[] shares);

    error BadTerms();

    /// @notice The payment address for a team's split. Pure function of the terms.
    function splitAddress(address[] calldata payees, uint16[] calldata shares, bytes32 ref)
        public
        view
        returns (address)
    {
        bytes32 h = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), ref, keccak256(_initCode(payees, shares)))
        );
        return address(uint160(uint256(h)));
    }

    /// @notice Checks terms are valid: 1–10 distinct non-zero payees, non-zero shares summing to 100%.
    function validTerms(address[] calldata payees, uint16[] calldata shares) public pure returns (bool) {
        uint256 n = payees.length;
        if (n == 0 || n > MAX_PAYEES || n != shares.length) return false;
        uint256 sum;
        for (uint256 i; i < n; i++) {
            if (payees[i] == address(0) || shares[i] == 0) return false;
            for (uint256 j; j < i; j++) if (payees[j] == payees[i]) return false;
            sum += shares[i];
        }
        return sum == TOTAL_BPS;
    }

    /// @notice Deploys the split at its address if it is not there yet. Anyone may call.
    function deploy(address[] calldata payees, uint16[] calldata shares, bytes32 ref) public returns (address split) {
        if (!validTerms(payees, shares)) revert BadTerms();
        split = splitAddress(payees, shares, ref);
        if (split.code.length == 0) {
            bytes memory code = _initCode(payees, shares);
            assembly {
                split := create2(0, add(code, 32), mload(code), ref)
            }
            if (split == address(0)) revert BadTerms();
            emit SplitDeployed(split, ref, payees, shares);
        }
    }

    /// @notice Deploys if needed and pays every member their share of `token`. Anyone may call.
    function settle(address[] calldata payees, uint16[] calldata shares, bytes32 ref, address token)
        external
        returns (address split, uint256 paid)
    {
        split = deploy(payees, shares, ref);
        paid = Split(split).distribute(token);
    }

    function _initCode(address[] calldata payees, uint16[] calldata shares) internal pure returns (bytes memory) {
        return abi.encodePacked(type(Split).creationCode, abi.encode(payees, shares));
    }
}

/// @notice A team's payment address. Whatever arrives here can only be paid out to the team,
///         in the agreed shares.
contract Split {
    address[] internal _payees;
    uint16[] internal _shares;

    /// @dev Shares a payee could not receive (e.g. a token blocks them). They can claim later.
    mapping(address => mapping(address => uint256)) public owed; // token => payee => amount
    mapping(address => uint256) public totalOwed; // token => amount reserved for claims
    mapping(address => uint256) public totalDistributed; // token => amount paid out or reserved

    event Distributed(address indexed token, uint256 amount);
    event Paid(address indexed token, address indexed payee, uint256 amount);
    event Owed(address indexed token, address indexed payee, uint256 amount);

    error NothingOwed();
    error TransferFailed();
    error Locked();

    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Locked();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address[] memory payees_, uint16[] memory shares_) {
        _payees = payees_;
        _shares = shares_;
    }

    function terms() external view returns (address[] memory payees, uint16[] memory shares) {
        return (_payees, _shares);
    }

    /// @notice Pays out the full new balance of `token`. Rounding dust goes to the first payee.
    function distribute(address token) external nonReentrant returns (uint256 amount) {
        amount = _balance(token) - totalOwed[token];
        if (amount == 0) return 0;
        totalDistributed[token] += amount;
        uint256 n = _payees.length;
        uint256 rest = amount;
        for (uint256 i = n; i > 0; i--) {
            uint256 idx = i - 1;
            uint256 part = idx == 0 ? rest : (amount * _shares[idx]) / 10_000;
            rest -= part;
            _pay(token, _payees[idx], part);
        }
        emit Distributed(token, amount);
    }

    /// @notice Claim a share that could not be sent during `distribute`.
    function claim(address token) external nonReentrant {
        uint256 a = owed[token][msg.sender];
        if (a == 0) revert NothingOwed();
        owed[token][msg.sender] = 0;
        totalOwed[token] -= a;
        if (!_send(token, msg.sender, a)) revert TransferFailed();
        emit Paid(token, msg.sender, a);
    }

    function _pay(address token, address to, uint256 a) internal {
        if (a == 0) return;
        if (_send(token, to, a)) {
            emit Paid(token, to, a);
        } else {
            owed[token][to] += a;
            totalOwed[token] += a;
            emit Owed(token, to, a);
        }
    }

    /// @dev Works with tokens that return nothing (USDT-style) or bool.
    function _send(address token, address to, uint256 a) internal returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, a));
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }

    function _balance(address token) internal view returns (uint256 b) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (ok && ret.length >= 32) b = abi.decode(ret, (uint256));
    }
}
