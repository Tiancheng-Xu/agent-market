import "@nomicfoundation/hardhat-toolbox";

import type { HardhatUserConfig } from "hardhat/config";

const networks: HardhatUserConfig["networks"] = {
  hardhat: {
    chainId: 31337,
  },
};

if (process.env.SEPOLIA_RPC_URL && process.env.SEPOLIA_DEPLOYER_PRIVATE_KEY) {
  networks.sepolia = {
    chainId: 11155111,
    url: process.env.SEPOLIA_RPC_URL,
    accounts: [process.env.SEPOLIA_DEPLOYER_PRIVATE_KEY],
  };
}

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks,
};

export default config;
