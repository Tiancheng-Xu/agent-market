import type { PropsWithChildren } from "react";
import { NavLink } from "react-router-dom";

import { navItems } from "../data";
import { shortAddress } from "../lib/domain";
import type { WalletState } from "../types";

export function Shell({ children, wallet, isSepolia, onConnect, onSwitch }: PropsWithChildren<{ wallet: WalletState; isSepolia: boolean; onConnect(): void; onSwitch(): void }>) {
  const walletLabel = wallet.status === "connecting" ? "Connecting..." : wallet.address ? shortAddress(wallet.address) : "Connect MetaMask";
  return (
    <div className="site-shell">
      <div className="testnet-banner">SEPOLIA TESTNET / SIMULATED YIELDS ONLY / NO REAL FINANCIAL RETURN</div>
      <aside className="sidebar">
        <NavLink to="/" className="brand"><span className="brand-mark">AM</span><span>Agent<br /><small>MARKET</small></span></NavLink>
        <nav aria-label="Primary navigation">
          {navItems.map(([path, label, glyph]) => <NavLink key={path} to={path} end={path === "/"}><span className="nav-glyph">{glyph}</span>{label}</NavLink>)}
        </nav>
        <div className="network-card"><span className="status-dot" /> <div><small>NETWORK</small><strong>Sepolia</strong></div></div>
      </aside>
      <div className="app-column">
        <header className="topbar">
          <label className="search"><span>SEARCH</span><input aria-label="Search" placeholder="Agents, tasks, or request IDs" /></label>
          <div className="wallet-actions">
            {wallet.address && !isSepolia ? <button className="button button-warning" onClick={onSwitch}>Switch to Sepolia</button> : null}
            <button className="button button-primary" onClick={onConnect} disabled={wallet.status === "connecting"}>{walletLabel}</button>
          </div>
        </header>
        {wallet.error ? <div className="wallet-error" role="alert">{wallet.error}</div> : null}
        <main>{children}</main>
        <footer className="site-footer">
          <div><strong>Agent Market</strong><span>Verifiable autonomous work on Ethereum Sepolia.</span></div>
          <nav aria-label="Delivery links"><a href="https://baby2b.online/">Portfolio</a><NavLink to="/">Project</NavLink><NavLink to="/evidence">Evidence</NavLink></nav>
        </footer>
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navItems.slice(0, 5).map(([path, label, glyph]) => <NavLink key={path} to={path} end={path === "/"}><span>{glyph}</span><small>{label}</small></NavLink>)}
      </nav>
    </div>
  );
}
