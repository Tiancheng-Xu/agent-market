import { Component, type PropsWithChildren } from "react";
import { useLocation } from "react-router-dom";
import { useLanguage } from "../i18n/LanguageProvider";

export function RouteLoadError() {
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  return <section className="panel" role="alert">
    <h1>{zh ? "页面暂时无法加载" : "This page could not load"}</h1>
    <p>{zh ? "请检查连接后刷新。已提交的操作不会自动重复。" : "Check your connection and reload. Submitted operations are not automatically repeated."}</p>
    <button className="button button-primary" type="button" onClick={() => window.location.reload()}>{zh ? "重新加载" : "Reload page"}</button>
    <a className="button button-ghost" href="/">{zh ? "返回首页" : "Return home"}</a>
  </section>;
}

class Boundary extends Component<PropsWithChildren, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() { return this.state.failed ? <RouteLoadError /> : this.props.children; }
}

export function RouteBoundary({ children }: PropsWithChildren) {
  const { pathname } = useLocation();
  return <Boundary key={pathname}>{children}</Boundary>;
}
