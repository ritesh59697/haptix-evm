// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {DemoSwapRouter, DemoToken} from "../script/demo/DemoDex.sol";
import {SpendPolicy} from "../src/SpendPolicy.sol";

contract DemoDexTest is Test {
    DemoToken usd;
    DemoToken stock;
    DemoSwapRouter router;
    address alice = address(0xA11CE);

    function setUp() public {
        usd = new DemoToken("Demo Dollar", "dUSD", 1);
        stock = new DemoToken("Demo Stock", "dSTK", 100);
        router = new DemoSwapRouter();
        usd.mint(alice, 1000 ether);
    }

    function _params(uint256 amountIn, uint256 minOut) internal view returns (DemoSwapRouter.ExactInputSingleParams memory) {
        return DemoSwapRouter.ExactInputSingleParams(address(usd), address(stock), 0, alice, amountIn, minOut, 0);
    }

    /// The account's swap policy recognizes this router's call by its selector.
    function test_SelectorMatchesThePolicy() public pure {
        assertEq(DemoSwapRouter.exactInputSingle.selector, bytes4(0x04e45aaf));
    }

    function test_SwapsAtTheFixedPrice() public {
        vm.startPrank(alice);
        usd.approve(address(router), 100 ether);
        router.exactInputSingle(_params(100 ether, 1 ether));
        vm.stopPrank();
        assertEq(usd.balanceOf(alice), 900 ether);
        assertEq(stock.balanceOf(alice), 1 ether);
    }

    function test_RevertsWithoutAllowance() public {
        vm.prank(alice);
        vm.expectRevert();
        router.exactInputSingle(_params(100 ether, 1 ether));
    }

    function test_RevertsBelowMinimumOut() public {
        vm.startPrank(alice);
        usd.approve(address(router), 100 ether);
        vm.expectRevert(abi.encodeWithSelector(DemoSwapRouter.TooLittleReceived.selector, 1 ether, 2 ether));
        router.exactInputSingle(_params(100 ether, 2 ether));
        vm.stopPrank();
    }
}
