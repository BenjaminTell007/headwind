// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Markets} from "../src/Markets.sol";
import {Faucet} from "../src/Faucet.sol";

/// forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast
/// Env: DEPLOYER_PRIVATE_KEY, ORACLE_ADDRESS (server key), FAUCET_FUND (wei, default 10 MON)
/// Drip is 0.25 MON: at the ~100 gwei testnet base fee a trade costs ~0.012 MON in gas,
/// so this is ~10 trades plus a few small stakes per burner wallet.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address oracle = vm.envOr("ORACLE_ADDRESS", vm.addr(pk));
        uint256 fund = vm.envOr("FAUCET_FUND", uint256(10 ether));

        vm.startBroadcast(pk);
        Markets markets = new Markets(oracle);
        Faucet faucet = new Faucet{value: fund}(oracle, 0.25 ether);
        vm.stopBroadcast();

        console.log("Markets", address(markets));
        console.log("Faucet ", address(faucet));
    }
}
