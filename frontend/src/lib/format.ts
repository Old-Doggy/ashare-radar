export const pct = (v: number | null | undefined, digits = 2, signed = true): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const s = (v * 100).toFixed(digits);
  return signed && v > 0 ? `+${s}%` : `${s}%`;
};

export const ratio = (v: number | null | undefined, digits = 0): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
};

export const num = (v: number | null | undefined, digits = 0): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

/* ------------------------------------------------------------------
 * 语言状态：模块级可变量 + useEffect 会晚于渲染，导致中英切换后
 * 金额单位要等下一次重渲染才切换（W5-01）。这里改成「实时取语言」：
 * i18n 初始化时用 registerLanguageSource 注入读取函数，money()/weekday()
 * 在调用瞬间取当前语言，切换语言后的同一轮重渲染即生效，27 处调用点不用改。
 * 保持零 import：本模块被 node --test 直接导入（data.test.mjs / chart-safety.test.mjs）。
 * ------------------------------------------------------------------ */
const readInitialLang = (): string => {
  try {
    const search = typeof window !== "undefined" ? window.location?.search ?? "" : "";
    return (
      new URLSearchParams(search).get("lang") ||
      (typeof localStorage !== "undefined" ? localStorage.getItem("bl.lang") : null) ||
      "zh"
    );
  } catch {
    return "zh";
  }
};

let fallbackLang = readInitialLang();
let languageSource: (() => string) | null = null;

/** 由 i18n 初始化注入，保证 money()/weekday() 默认语言实时跟随 i18n.language。 */
export const registerLanguageSource = (source: () => string) => {
  languageSource = source;
};

/** 兼容旧接口：作为 getter 缺失时的兜底（不再依赖渲染后的 effect 才生效）。 */
export const setFmtLang = (l: string) => {
  fallbackLang = l;
};

export const currentLang = (): string => {
  try {
    const value = languageSource ? languageSource() : fallbackLang;
    return value === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
};

/** 前端版本兜底（静态/API 都优先用 meta.version；旧包没有时回落到发布版本）。 */
export const VERSION_FALLBACK = "0.4.3";

/** 统一版本串：Briefing 页脚与 About 页脚共用，避免再次出现硬编码 v0.3（W9-06/W14-14）。 */
export const appVersion = (version?: string | null): string => {
  const raw = typeof version === "string" ? version.trim().replace(/^v/i, "") : "";
  return /^\d+\.\d+/.test(raw) ? raw : VERSION_FALLBACK;
};

export const versionLabel = (version?: string | null): string => `v${appVersion(version)}`;

export const money = (v: number | null | undefined, lang = currentLang()): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (lang === "en") {
    if (abs >= 1e12) return `¥${(v / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `¥${(v / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `¥${(v / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `¥${(v / 1e3).toFixed(0)}K`;
    return `¥${v.toFixed(0)}`;
  }
  if (abs >= 1e12) return `${(v / 1e12).toFixed(2)}万亿`;
  if (abs >= 1e8) return `${(v / 1e8).toFixed(abs >= 1e10 ? 0 : 1)}亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(0)}万`;
  return v.toFixed(0);
};

export const signed = (v: number | null | undefined, digits = 2): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : s;
};

export const trendClass = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "flat" : v > 0 ? "up" : v < 0 ? "down" : "flat";

export const shortDate = (d: string): string => (d ? d.slice(5).replace("-", "/") : "—");

export const weekday = (d: string, lang = currentLang()): string => {
  if (!d) return "";
  const dt = new Date(`${d}T00:00:00`);
  const zh = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][dt.getDay()];
  const en = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getDay()];
  return lang === "en" ? en : zh;
};
