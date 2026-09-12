import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { OrderDetailPage } from "./OrderDetailPage";
import { createOrderQueryClient } from "./orderQueryClient";
import { authenticateWalletSession } from "../lib/chainClient";
import { useLanguage } from "../i18n/LanguageProvider";
import { subscribeWalletSession, walletSessionRevision } from "../lib/walletSession";

export type OrderDetailRouteProps = {
  walletAddress?: string | null;
};

export default function OrderDetailRoute({ walletAddress = null }: OrderDetailRouteProps) {
  return <OrderSession key={walletAddress ?? "guest"} walletAddress={walletAddress} />;
}

function OrderSession({ walletAddress = null }: OrderDetailRouteProps) {
  const { id } = useParams();
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  const live = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id ?? "");
  const [session, setSession] = useState<"idle" | "signing" | "ready" | "error">("idle");
  const active = useRef(true);
  const loginAttempt = useRef(0);
  const [client] = useState(createOrderQueryClient);
  useEffect(() => {
    active.current = true;
    const unsubscribe = subscribeWalletSession((notice) => {
      loginAttempt.current += 1;
      setSession(notice === "logout-failed" ? "error" : "idle");
      void client.cancelQueries().catch(() => undefined);
      client.clear();
    });
    return () => {
      active.current = false;
      loginAttempt.current += 1;
      unsubscribe();
      void client.cancelQueries().catch(() => undefined);
      client.clear();
    };
  }, [client]);
  async function login() {
    if (!walletAddress || session === "signing") return;
    const attempt = ++loginAttempt.current;
    const revision = walletSessionRevision();
    setSession("signing");
    try {
      await authenticateWalletSession(walletAddress);
      if (active.current && attempt === loginAttempt.current && revision === walletSessionRevision()) setSession("ready");
    } catch {
      if (active.current && attempt === loginAttempt.current) setSession("error");
    }
  }
  if (live && (!walletAddress || session !== "ready")) return (
    <section className="panel" aria-labelledby="order-login-heading">
      <h1 id="order-login-heading">{zh ? "登录后查看订单" : "Sign in to view this order"}</h1>
      <p>{zh ? "先连接 Sepolia 钱包，再签署一次登录消息。签名不会发送交易，也不会授予其他钱包的订单权限。" : "Connect a Sepolia wallet, then sign a login message. Signing sends no transaction and grants no access to another wallet's orders."}</p>
      <button className="button primary" disabled={!walletAddress || session === "signing"} onClick={() => void login()}>
        {session === "signing" ? (zh ? "等待钱包签名" : "Waiting for signature") : (zh ? "签名登录" : "Sign in with wallet")}
      </button>
      {session === "error" ? <p role="alert">{zh ? "登录未完成，请检查网络、钱包账户和 Sepolia 网络后重试。" : "Sign-in did not complete. Check the connection, wallet account and Sepolia network, then retry."}</p> : null}
    </section>
  );
  return (
    <QueryClientProvider client={client}>
      <OrderDetailPage key={`${id}:${walletAddress ?? "guest"}`} walletAddress={walletAddress} />
    </QueryClientProvider>
  );
}
