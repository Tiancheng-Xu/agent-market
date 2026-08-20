import { useCallback, useState } from "react";

import type { WalletState } from "../types";

const SEPOLIA_HEX = "0xaa36a7";

export function useWallet() {
  const [wallet, setWallet] = useState<WalletState>({
    address: null,
    chainId: null,
    status: "disconnected",
    error: null,
  });

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setWallet((state) => ({ ...state, status: "unavailable", error: "MetaMask was not detected." }));
      return;
    }
    setWallet((state) => ({ ...state, status: "connecting", error: null }));
    try {
      const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
      const chainId = (await window.ethereum.request({ method: "eth_chainId" })) as string;
      setWallet({ address: accounts[0] ?? null, chainId, status: "connected", error: null });
    } catch {
      setWallet((state) => ({ ...state, status: "error", error: "Wallet connection was not approved." }));
    }
  }, []);

  const switchToSepolia = useCallback(async () => {
    if (!window.ethereum) return;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA_HEX }] });
      setWallet((state) => ({ ...state, chainId: SEPOLIA_HEX, error: null }));
    } catch {
      setWallet((state) => ({ ...state, error: "Switch to Sepolia in MetaMask to continue." }));
    }
  }, []);

  return { wallet, connect, switchToSepolia, isSepolia: wallet.chainId === SEPOLIA_HEX };
}
