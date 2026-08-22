import { useCallback, useState } from "react";

import type { WalletState } from "../types";

const SEPOLIA_HEX = "0xaa36a7";

export function useWallet() {
  const [wallet, setWallet] = useState<WalletState>({
    address: null,
    chainId: null,
    status: "disconnected",
    error: null,
    message: null,
  });

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setWallet((state) => ({ ...state, status: "unavailable", error: "MetaMask was not detected.", message: null }));
      return;
    }
    setWallet((state) => ({
      ...state,
      status: "connecting",
      error: null,
      message: "Opening MetaMask. If it feels slow, unlock the extension popup.",
    }));
    const slowTimer = window.setTimeout(() => {
      setWallet((state) => state.status === "connecting"
        ? { ...state, message: "MetaMask is still waiting. Check the extension popup or unlock the wallet." }
        : state);
    }, 3500);
    try {
      const chainIdPromise = window.ethereum.request({ method: "eth_chainId" }) as Promise<string>;
      const existingAccounts = (await window.ethereum.request({ method: "eth_accounts" })) as string[];
      const accounts = existingAccounts.length > 0
        ? existingAccounts
        : (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
      const chainId = await chainIdPromise;
      setWallet({
        address: accounts[0] ?? null,
        chainId,
        status: "connected",
        error: null,
        message: "Connected. No transaction has been sent.",
      });
    } catch {
      setWallet((state) => ({ ...state, status: "error", error: "Wallet connection was not approved.", message: null }));
    } finally {
      window.clearTimeout(slowTimer);
    }
  }, []);

  const switchToSepolia = useCallback(async () => {
    if (!window.ethereum) return;
    setWallet((state) => ({ ...state, message: "Requesting Sepolia switch in MetaMask.", error: null }));
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA_HEX }] });
      setWallet((state) => ({ ...state, chainId: SEPOLIA_HEX, error: null, message: "Sepolia selected. Continue with YD approval when the contract is verified." }));
    } catch {
      setWallet((state) => ({ ...state, error: "Switch to Sepolia in MetaMask to continue.", message: null }));
    }
  }, []);

  return { wallet, connect, switchToSepolia, isSepolia: wallet.chainId === SEPOLIA_HEX };
}
