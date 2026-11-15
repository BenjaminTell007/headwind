// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Markets} from "../src/Markets.sol";
import {Faucet} from "../src/Faucet.sol";

/// forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast
/// Env: DEPLOYER_PRIVATE_KEY, ORACLE_ADDRESS (server key), FAUCET_FUND (wei, e.g. 5 MON)
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address oracle = vm.envOr("ORACLE_ADDRESS", vm.addr(pk));
        uint256 fund = vm.envOr("FAUCET_FUND", uint256(5 ether));

        vm.startBroadcast(pk);
        Markets markets = new Markets(oracle);
        Faucet faucet = new Faucet{value: fund}(oracle, 0.05 ether);
        vm.stopBroadcast();

        console.log("Markets", address(markets));
        console.log("Faucet ", address(faucet));
    }
}
