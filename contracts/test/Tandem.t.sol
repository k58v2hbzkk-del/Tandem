// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {TandemFactory, Split} from "../src/Tandem.sol";

/// Standard token returning bool (USDC-style).
contract Coin {
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public blocked;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function block_(address who) external { blocked[who] = true; }
    function unblock(address who) external { blocked[who] = false; }
    function transfer(address to, uint256 a) external returns (bool) {
        require(!blocked[to], "blocked");
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// Token whose transfer returns nothing (USDT-style).
contract NoReturnCoin {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
    }
}

/// Token that tries to re-enter distribute when sending.
contract EvilCoin {
    mapping(address => uint256) public balanceOf;
    address public target;
    bool public tried;
    bool public reentered;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function setTarget(address t) external { target = t; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        if (!tried && target != address(0)) {
            tried = true;
            (reentered, ) = target.call(abi.encodeWithSelector(Split.distribute.selector, address(this)));
        }
        return true;
    }
}

contract TandemTest is Test {
    TandemFactory f;
    Coin usdc;
    NoReturnCoin usdt;

    address lead = makeAddr("lead");
    address researcher = makeAddr("researcher");
    address writer = makeAddr("writer");
    bytes32 constant REF = keccak256("ORDER-001");

    function setUp() public {
        f = new TandemFactory();
        usdc = new Coin();
        usdt = new NoReturnCoin();
    }

    function team() internal view returns (address[] memory p, uint16[] memory s) {
        p = new address[](3);
        s = new uint16[](3);
        (p[0], p[1], p[2]) = (lead, researcher, writer);
        (s[0], s[1], s[2]) = (5000, 3000, 2000);
    }

    function test_payBeforeDeployThenSettle() public {
        (address[] memory p, uint16[] memory s) = team();
        address addr = f.splitAddress(p, s, REF);
        assertEq(addr.code.length, 0);
        usdc.mint(addr, 1_000_000); // HSP pays the address before any contract exists
        (address split, uint256 paid) = f.settle(p, s, REF, address(usdc));
        assertEq(split, addr);
        assertEq(paid, 1_000_000);
        assertEq(usdc.balanceOf(lead), 500_000);
        assertEq(usdc.balanceOf(researcher), 300_000);
        assertEq(usdc.balanceOf(writer), 200_000);
        assertEq(usdc.balanceOf(split), 0);
    }

    function test_addressCommitsToTerms() public {
        (address[] memory p, uint16[] memory s) = team();
        address a = f.splitAddress(p, s, REF);
        s[0] = 5100;
        s[1] = 2900;
        assertTrue(f.splitAddress(p, s, REF) != a, "changed share must change address");
        (p, s) = team();
        p[2] = makeAddr("impostor");
        assertTrue(f.splitAddress(p, s, REF) != a, "changed payee must change address");
        (p, s) = team();
        assertTrue(f.splitAddress(p, s, keccak256("ORDER-002")) != a, "each order gets its own address");
    }

    function test_rejectsBadTerms() public {
        (address[] memory p, uint16[] memory s) = team();
        s[2] = 1999; // sums to 9999
        vm.expectRevert(TandemFactory.BadTerms.selector);
        f.deploy(p, s, REF);

        (p, s) = team();
        p[1] = lead; // duplicate
        assertFalse(f.validTerms(p, s));
        (p, s) = team();
        p[0] = address(0);
        assertFalse(f.validTerms(p, s));
        (p, s) = team();
        s[0] = 0;
        s[1] = 8000;
        assertFalse(f.validTerms(p, s));
        address[] memory none = new address[](0);
        uint16[] memory noShares = new uint16[](0);
        assertFalse(f.validTerms(none, noShares));
    }

    function test_roundingDustGoesToFirstPayee() public {
        (address[] memory p, uint16[] memory s) = team();
        address addr = f.splitAddress(p, s, REF);
        usdc.mint(addr, 7);
        f.settle(p, s, REF, address(usdc));
        // 7*3000/10000 = 2, 7*2000/10000 = 1, lead gets the remaining 4
        assertEq(usdc.balanceOf(researcher), 2);
        assertEq(usdc.balanceOf(writer), 1);
        assertEq(usdc.balanceOf(lead), 4);
    }

    function test_secondPaymentOnlyNewFunds() public {
        (address[] memory p, uint16[] memory s) = team();
        address addr = f.splitAddress(p, s, REF);
        usdc.mint(addr, 1000);
        f.settle(p, s, REF, address(usdc));
        usdc.mint(addr, 2000);
        (, uint256 paid) = f.settle(p, s, REF, address(usdc));
        assertEq(paid, 2000);
        assertEq(usdc.balanceOf(lead), 1500);
        assertEq(Split(addr).totalDistributed(address(usdc)), 3000);
        (, paid) = f.settle(p, s, REF, address(usdc));
        assertEq(paid, 0);
    }

    function test_usdtStyleToken() public {
        (address[] memory p, uint16[] memory s) = team();
        address addr = f.splitAddress(p, s, REF);
        usdt.mint(addr, 10_000);
        f.settle(p, s, REF, address(usdt));
        assertEq(usdt.balanceOf(lead), 5000);
        assertEq(usdt.balanceOf(writer), 2000);
    }

    function test_blockedPayeeDoesNotStopOthers() public {
        (address[] memory p, uint16[] memory s) = team();
        address addr = f.splitAddress(p, s, REF);
        usdc.mint(addr, 1000);
        usdc.block_(writer);
        f.settle(p, s, REF, address(usdc));
        assertEq(usdc.balanceOf(lead), 500);
        assertEq(usdc.balanceOf(researcher), 300);
        assertEq(Split(addr).owed(address(usdc), writer), 200);
        // reserved funds are not redistributed
        (, uint256 paid) = f.settle(p, s, REF, address(usdc));
        assertEq(paid, 0);
        usdc.unblock(writer);
        vm.prank(writer);
        Split(addr).claim(address(usdc));
        assertEq(usdc.balanceOf(writer), 200);
        vm.prank(writer);
        vm.expectRevert(Split.NothingOwed.selector);
        Split(addr).claim(address(usdc));
    }

    function test_anyoneCanSettleButFundsOnlyGoToTeam() public {
        (address[] memory p, uint16[] memory s) = team();
        address addr = f.splitAddress(p, s, REF);
        usdc.mint(addr, 100);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        f.settle(p, s, REF, address(usdc));
        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(usdc.balanceOf(lead) + usdc.balanceOf(researcher) + usdc.balanceOf(writer), 100);
    }

    function test_termsReadable() public {
        (address[] memory p, uint16[] memory s) = team();
        address addr = f.deploy(p, s, REF);
        (address[] memory p2, uint16[] memory s2) = Split(addr).terms();
        assertEq(p2.length, 3);
        assertEq(p2[1], researcher);
        assertEq(s2[2], 2000);
        // deploying again is a no-op
        assertEq(f.deploy(p, s, REF), addr);
    }

    function test_reentryBlocked() public {
        EvilCoin evil = new EvilCoin();
        (address[] memory p, uint16[] memory s) = team();
        address addr = f.deploy(p, s, REF);
        evil.setTarget(addr);
        evil.mint(addr, 1000);
        Split(addr).distribute(address(evil));
        assertTrue(evil.tried());
        assertFalse(evil.reentered());
        assertEq(evil.balanceOf(lead) + evil.balanceOf(researcher) + evil.balanceOf(writer), 1000);
    }

    function test_settleGas() public {
        (address[] memory p, uint16[] memory s) = team();
        address addr = f.splitAddress(p, s, REF);
        usdc.mint(addr, 1_000_000);
        uint256 g = gasleft();
        f.settle(p, s, REF, address(usdc));
        emit log_named_uint("deploy + settle 3 payees, gas", g - gasleft());
    }

    function testFuzz_sharesAlwaysSumToAmount(uint96 amount, uint16 a, uint16 b) public {
        a = uint16(bound(a, 1, 9998));
        b = uint16(bound(b, 1, 9999 - a));
        address[] memory p = new address[](3);
        uint16[] memory s = new uint16[](3);
        (p[0], p[1], p[2]) = (lead, researcher, writer);
        (s[0], s[1], s[2]) = (a, b, uint16(10_000 - a - b));
        address addr = f.splitAddress(p, s, REF);
        usdc.mint(addr, amount);
        f.settle(p, s, REF, address(usdc));
        assertEq(usdc.balanceOf(lead) + usdc.balanceOf(researcher) + usdc.balanceOf(writer), amount);
        assertEq(usdc.balanceOf(addr), 0);
    }
}
