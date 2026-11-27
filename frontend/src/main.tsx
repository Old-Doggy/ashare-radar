import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter } from "react-router-dom";
import App from "./App";
import "./index.css";
import "./lib/i18n";
import { ApiError, SectorRollUnavailable, UnavailableError } from "./lib/api";

/** 只对「可能恢复」的错误重试：5xx / 网络抖动。
 * 确定性错误（4xx、离线包明确缺数、本地持仓损坏）立刻展示错误，不做 7s 无谓等待（W5-06）。 */
export const shouldRetry = (count: number, error: unknown): boolean => {
  if (error instanceof UnavailableError || error instanceof SectorRollUnavailable) return false;
  if (error instanceof ApiError) return error.status >= 500 && count < 2;
  const message = error instanceof Error ? error.message : "";
  if (/offline export|Invalid saved positions|本地持仓数据无效|static mode/i.test(message)) return false;
  return count < 2;
};

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: shouldRetry,
      retryDelay: (n) => Math.min(1000 * 2 ** n, 8000),
      staleTime: 60_000,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <HashRouter>
        <App />
      </HashRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
