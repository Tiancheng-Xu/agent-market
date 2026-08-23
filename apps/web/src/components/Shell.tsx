import { useEffect, useMemo, useState, type FormEvent, type PropsWithChildren } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";

import { agents, navItems, tasks } from "../data";
import { Localized, useLanguage } from "../i18n/LanguageProvider";
import { shortAddress } from "../lib/domain";
import type { WalletState } from "../types";
import { applyPerformanceProfile, detectPerformanceProfile, watchPerformanceProfile, type PerformanceProfile } from "../performance/degradation";

export type MarketSearchResult = { path: string; title: string; scope: "Route" | "Agent" | "Task" };

export function findMarketSearchResults(query: string): MarketSearchResult[] {
  const value = query.trim().toLowerCase();
  if (!value) return [];
  const routeResults: MarketSearchResult[] = navItems
    .filter(([, label]) => label.toLowerCase().includes(value))
    .map(([path, label]) => ({ path, title: label, scope: "Route" }));
  const agentResults: MarketSearchResult[] = agents
    .filter((agent) => `${agent.name} ${agent.category} ${agent.tags.join(" ")}`.toLowerCase().includes(value))
    .map((agent) => ({ path: `/agents/${agent.id}`, title: agent.name, scope: "Agent" }));
  const taskResults: MarketSearchResult[] = tasks
    .filter((task) => `${task.id} ${task.title} ${task.category} ${task.tags.join(" ")}`.toLowerCase().includes(value))
    .map((task) => ({ path: `/tasks/${task.id}`, title: task.title, scope: "Task" }));
  return [...routeResults, ...agentResults, ...taskResults].slice(0, 6);
}

export function Shell({ children, wallet, isSepolia, onConnect, onSwitch }: PropsWithChildren<{ wallet: WalletState; isSepolia: boolean; onConnect(): void; onSwitch(): void }>) {
  const { locale, setLocale, t } = useLanguage();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");
  const [performanceProfile, setPerformanceProfile] = useState<PerformanceProfile>(() => detectPerformanceProfile());
  const [performanceIssue, setPerformanceIssue] = useState<string | null>(null);
  const walletLabel = wallet.status === "connecting" ? "Connecting..." : wallet.address ? shortAddress(wallet.address) : "Connect MetaMask";
  const walletMessage = wallet.message ?? (wallet.status === "connecting" ? "Confirm the MetaMask popup. This site never sees your private key." : null);
  const searchResults = useMemo(() => findMarketSearchResults(searchQuery), [searchQuery]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const first = searchResults[0];
    if (!first) return;
    navigate(first.path);
    setSearchQuery("");
  }
  useEffect(() => watchPerformanceProfile((profile) => { setPerformanceProfile(profile); applyPerformanceProfile(profile); }), []);
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ status: string; reasonCode?: string }>).detail;
      setPerformanceIssue(detail.status === "degraded" ? detail.reasonCode ?? "PERFORMANCE_UNAVAILABLE" : null);
    };
    globalThis.addEventListener("agent-market:performance-status", update);
    return () => globalThis.removeEventListener("agent-market:performance-status", update);
  }, []);
  return (
    <Localized><div className="site-shell">
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
          <div className="search-wrap">
            <form className="search" onSubmit={submitSearch}>
              <span>SEARCH</span>
              <input aria-label="Search" placeholder="Agents, tasks, or request IDs" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
            </form>
            {searchQuery ? <div className="search-results" role="listbox" aria-label="Search results">
              {searchResults.length ? searchResults.map((result) => (
                <Link key={`${result.scope}-${result.path}`} to={result.path} onClick={() => setSearchQuery("")}>
                  <span>{result.scope}</span><strong>{result.title}</strong>
                </Link>
              )) : <div className="search-empty" role="status">No matches</div>}
            </div> : null}
          </div>
          <div className="wallet-actions">
            <div className="language-toggle" role="group" aria-label={t("Language")}>
              <button type="button" aria-pressed={locale === "zh-CN"} onClick={() => setLocale("zh-CN")}>中文</button>
              <button type="button" aria-pressed={locale === "en"} onClick={() => setLocale("en")}>EN</button>
            </div>
            {wallet.address && !isSepolia ? <button className="button button-warning" onClick={onSwitch}>Switch to Sepolia</button> : null}
            <button className="button button-primary" onClick={onConnect} disabled={wallet.status === "connecting"}>{walletLabel}</button>
          </div>
        </header>
        {wallet.error ? <div className="wallet-error" role="alert">{wallet.error}</div> : null}
        {walletMessage ? <div className="wallet-status" role="status">{walletMessage}</div> : null}
        {performanceProfile.mode !== "full" || performanceIssue ? <div className="degradation-banner" role="status">{locale === "zh-CN" ? `当前为${performanceProfile.mode === "offline" ? "离线" : "降级"}模式：页面保持可用，但不会伪造外部调用成功。` : `${performanceProfile.mode === "offline" ? "Offline" : "Degraded"} mode: the page stays usable without faking external success.`}<small>{[...performanceProfile.reasonCodes, ...(performanceIssue ? [performanceIssue] : [])].join(" / ")}</small></div> : null}
        <main>{children}</main>
        <footer className="site-footer">
          <div><strong>Agent Market</strong><span>Verifiable autonomous work on Ethereum Sepolia.</span></div>
          <nav aria-label="Delivery links"><a href="https://baby2b.online/">Portfolio</a><NavLink to="/">Project</NavLink><NavLink to="/evidence">Evidence</NavLink></nav>
        </footer>
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navItems.slice(0, 5).map(([path, label, glyph]) => <NavLink key={path} to={path} end={path === "/"}><span>{glyph}</span><small>{label}</small></NavLink>)}
      </nav>
    </div></Localized>
  );
}
