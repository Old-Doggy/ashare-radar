import { Link, Route, Routes } from "react-router-dom";
import { useTranslation } from "react-i18next";
import Shell from "./components/Shell";
import Today from "./pages/Today";
import Market from "./pages/Market";
import Regime from "./pages/Regime";
import Sectors from "./pages/Sectors";
import Stocks from "./pages/Stocks";
import Sentiment from "./pages/Sentiment";
import Watchlist from "./pages/Watchlist";
import About from "./pages/About";
import Briefing from "./pages/Briefing";
import ChartLab from "./pages/ChartLab";

/** 未知 hash 路由回落页：旧链接/手误不再整页空白（W5-06）。 */
export function NotFound() {
  const { i18n } = useTranslation();
  const zh = i18n.language === "zh";
  return (
    <div className="card flex min-h-[320px] flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="kicker">404</div>
      <h1 className="serif text-[24px] font-bold tracking-tight text-[var(--text)]">
        {zh ? "页面不存在" : "Page not found"}
      </h1>
      <p className="max-w-[46ch] text-[13px] leading-relaxed text-[var(--muted)]">
        {zh ? "该链接可能已过期。返回今日盘面继续查看市场结构。" : "This link may be out of date. Return to Today to keep exploring market structure."}
      </p>
      <Link to="/" className="text-[13px] font-medium text-[var(--accent)] hover:underline">
        {zh ? "返回今日盘面 →" : "Back to Today →"}
      </Link>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Today />} />
        <Route path="market" element={<Market />} />
        <Route path="regime" element={<Regime />} />
        <Route path="sectors" element={<Sectors />} />
        <Route path="stocks" element={<Stocks />} />
        <Route path="sentiment" element={<Sentiment />} />
        <Route path="watchlist" element={<Watchlist />} />
        <Route path="about" element={<About />} />
        <Route path="briefing" element={<Briefing />} />
        <Route path="labs" element={<ChartLab />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
