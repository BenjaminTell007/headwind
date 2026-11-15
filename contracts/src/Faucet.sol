// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Gas faucet for burner wallets
/// @notice Holds testnet MON. The server's relayer key calls drip() once per new burner wallet,
///         so nobody in the audience needs a wallet extension or a public faucet.
contract Faucet {
    address public owner;
    address public relayer;
    uint256 public amount;
    mapping(address => bool) public dripped;

    event Dripped(address indexed to, uint256 amount);

    error NotOwner();
    error NotRelayer();
    error AlreadyDripped();
    error Empty();
    error TransferFailed();

    constructor(address relayer_, uint256 amount_) payable {
        owner = msg.sender;
        relayer = relayer_ == address(0) ? msg.sender : relayer_;
        amount = amount_;
    }

    receive() external payable {}

    function drip(address to) external {
        if (msg.sender != relayer) revert NotRelayer();
        if (dripped[to]) revert AlreadyDripped();
        if (address(this).balance < amount) revert Empty();
        dripped[to] = true;
        emit Dripped(to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function setRelayer(address relayer_) external {
        if (msg.sender != owner) revert NotOwner();
        relayer = relayer_;
    }

    function setAmount(uint256 amount_) external {
        if (msg.sender != owner) revert NotOwner();
        amount = amount_;
    }

    function withdraw() external {
        if (msg.sender != owner) revert NotOwner();
        (bool ok,) = owner.call{value: address(this).balance}("");
        if (!ok) revert TransferFailed();
    }
}
