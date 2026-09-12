import { useCallback, useEffect, useState } from "react";
import { invalidateWalletSession, subscribeWalletSession, walletSessionRevision } from "../lib/walletSession";

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

  useEffect(() => {
    const provider = window.ethereum;
    const unsubscribe = subscribeWalletSession((notice) => {
      setWallet({ address: null, chainId: null, status: "disconnected",
        error: notice === "logout-failed" ? "Server logout could not be confirmed. Reconnect to retry authentication." : null,
        message: "Wallet session invalidated. Reconnect to continue with the current identity." });
    });
    const changed = () => { void invalidateWalletSession().catch(() => undefined); };
    for (const event of ["accountsChanged", "chainChanged", "disconnect"]) provider?.on?.(event, changed);
    return () => {
      unsubscribe();
      for (const event of ["accountsChanged", "chainChanged", "disconnect"]) provider?.removeListener?.(event, changed);
    };
  }, []);

  const connect = useCallback(async () => {
    const revision = walletSessionRevision();
    if (!window.ethereum) {
      void invalidateWalletSession().catch(() => undefined);
      setWallet({ address: null, chainId: null, status: "unavailable", error: "MetaMask was not detected.", message: null });
      return;
    }
    setWallet((state) => ({
      ...state,
      address: null,
      chainId: null,
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
      const existingAccounts = (await window.ethereum.request({ method: "eth_accounts" })) as string[];
      const accounts = existingAccounts.length > 0
        ? existingAccounts
        : (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
      const chainId = await window.ethereum.request({ method: "eth_chainId" }) as string;
      if (revision !== walletSessionRevision()) return;
      if (!accounts[0]) throw new Error("WALLET_ACCOUNT_UNAVAILABLE");
      setWallet({
        address: accounts[0] ?? null,
        chainId,
        status: "connected",
        error: null,
        message: "Connected. No transaction has been sent.",
      });
    } catch {
      if (revision !== walletSessionRevision()) return;
      void invalidateWalletSession().catch(() => undefined);
      setWallet({ address: null, chainId: null, status: "error", error: "Wallet connection was not approved.", message: null });
    } finally {
      window.clearTimeout(slowTimer);
    }
  }, []);

  const switchToSepolia = useCallback(async () => {
    if (!window.ethereum) return;
    const revision = walletSessionRevision();
    const provider = window.ethereum;
    setWallet((state) => ({ ...state, message: "Requesting Sepolia switch in MetaMask.", error: null }));
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA_HEX }] });
      if (revision !== walletSessionRevision()) return;
      const chainId = await provider.request({ method: "eth_chainId" });
      if (revision !== walletSessionRevision()) return;
      if (chainId !== SEPOLIA_HEX) throw new Error("CHAIN_ID_MISMATCH");
      setWallet((state) => ({ ...state, chainId: SEPOLIA_HEX, error: null, message: "Sepolia selected. Reconnect to confirm the current wallet identity." }));
    } catch {
      if (revision !== walletSessionRevision()) return;
      setWallet((state) => ({ ...state, error: "Switch to Sepolia in MetaMask to continue.", message: null }));
    }
  }, []);

  return { wallet, connect, switchToSepolia, isSepolia: wallet.chainId === SEPOLIA_HEX };
}
