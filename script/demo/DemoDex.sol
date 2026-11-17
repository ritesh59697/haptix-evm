// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title Demo tokens and a fixed-price router, for testnet demos of agent budgets only.
/// @notice NOT production code and worth nothing: anyone can mint, and the router mints
///         its output at a fixed price. It exists because Robinhood Chain testnet has no
///         documented Uniswap deployment. The router takes the same call as Uniswap's
///         SwapRouter02, so the account's swap policy reads it like the real thing.
contract DemoToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    /// @notice Price in the router's unit of account, used for the fixed swap rate.
    uint256 public immutable price;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint256 price_) {
        name = name_;
        symbol = symbol_;
        price = price_;
    }

    /// @notice Open to anyone: this is a testnet demo token.
    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external {
        _spend(from, amount);
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _spend(from, amount);
        _move(from, to, amount);
        return true;
    }

    function _spend(address from, uint256 amount) private {
        if (from != msg.sender) allowance[from][msg.sender] -= amount;
    }

    function _move(address from, address to, uint256 amount) private {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

contract DemoSwapRouter {
    /// @dev Same layout as Uniswap's SwapRouter02 ExactInputSingleParams.
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    error TooLittleReceived(uint256 amountOut, uint256 minimum);

    event Swap(address indexed payer, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);

    /// @notice Burns tokenIn from the caller and mints tokenOut at the tokens' fixed prices.
    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut) {
        DemoToken tokenIn = DemoToken(p.tokenIn);
        DemoToken tokenOut = DemoToken(p.tokenOut);
        amountOut = (p.amountIn * tokenIn.price()) / tokenOut.price();
        if (amountOut < p.amountOutMinimum) revert TooLittleReceived(amountOut, p.amountOutMinimum);
        tokenIn.burn(msg.sender, p.amountIn);
        tokenOut.mint(p.recipient, amountOut);
        emit Swap(msg.sender, p.tokenIn, p.tokenOut, p.amountIn, amountOut);
    }
}
