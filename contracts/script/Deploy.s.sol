// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Markets} from "../src/Markets.sol";
import {Faucet} from "../src/Faucet.sol";

/// forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast
/// Env (in PRIVATE.md, exported):
///   DEPLOYER_PRIVATE_KEY   the 50 MON wallet
///   ORACLE_ADDRESS         server key that settles markets and drips the faucet
///   PRICER_ADDRESS         server key that signs quotes (can be the same as the oracle)
///   VAULT_SEED             MON the deployer underwrites at launch (default 20)
///   SUBJECT_CAP            max vault seed per ship/port/strait (default 3 MON)
///   FAUCET_FUND            default 10 MON. Drip is 0.25 MON: ~10 trades at the ~100 gwei base fee
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address oracle = vm.envOr("ORACLE_ADDRESS", vm.addr(pk));
        address pricer = vm.envOr("PRICER_ADDRESS", oracle);
        uint256 vaultSeed = vm.envOr("VAULT_SEED", uint256(20 ether));
        uint256 subjectCap = vm.envOr("SUBJECT_CAP", uint256(3 ether));
        uint256 fund = vm.envOr("FAUCET_FUND", uint256(10 ether));

        vm.startBroadcast(pk);
        Markets markets = new Markets{value: vaultSeed}(oracle, pricer, subjectCap);
        Faucet faucet = new Faucet{value: fund}(oracle, 0.25 ether);
        vm.stopBroadcast();

        console.log("Markets", address(markets));
        console.log("Faucet ", address(faucet));
    }
}
