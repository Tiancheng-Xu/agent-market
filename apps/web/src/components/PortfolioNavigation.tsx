interface PortfolioNavigationItem {
  href: string;
  label: string;
  pathname?: string;
}

export const portfolioNavigation: readonly PortfolioNavigationItem[] = [
  { href: "https://baby2b.online/dashboard/", label: "Portfolio Home" },
  { href: "https://agent-market.baby2b.online/", label: "Project Home", pathname: "/" },
  { href: "https://agent-market.baby2b.online/evidence", label: "Evidence", pathname: "/evidence" },
] as const;

export function PortfolioNavigation({ pathname }: { pathname: string }) {
  return (
    <nav aria-label="Portfolio navigation">
      {portfolioNavigation.map(({ href, label, pathname: targetPathname }) => (
        <a href={href} aria-current={pathname === targetPathname ? "page" : undefined} key={href}>
          {label}
        </a>
      ))}
    </nav>
  );
}
