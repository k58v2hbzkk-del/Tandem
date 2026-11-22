// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;
import {Test, console2} from "forge-std/Test.sol";
import {TandemFactory} from "../src/Tandem.sol";
contract AddrTest is Test {
    function test_printAddress() public {
        TandemFactory f = new TandemFactory();
        address[] memory p = new address[](2);
        uint16[] memory s = new uint16[](2);
        p[0] = address(0x1111); p[1] = address(0x2222); s[0] = 6000; s[1] = 4000;
        console2.log("factory", address(f));
        console2.log("split", f.splitAddress(p, s, keccak256("ORDER-1")));
    }
}
