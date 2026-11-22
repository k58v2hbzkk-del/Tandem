// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/// Minimal EIP-3009 token, used only in local end-to-end tests of the HSP signing flow.
contract MockUSDC {
    string public constant name = "USD Coin";
    string public constant version = "2";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(bytes32 => bool) public used;
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 constant TWA = keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");

    constructor() {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, address(this)));
    }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        require(block.timestamp > validAfter && block.timestamp < validBefore, "time");
        require(!used[nonce], "used");
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(TWA, from, to, value, validAfter, validBefore, nonce))));
        require(ecrecover(d, v, r, s) == from, "bad sig");
        used[nonce] = true;
        balanceOf[from] -= value; balanceOf[to] += value;
    }
}
