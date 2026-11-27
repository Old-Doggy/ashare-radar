import { create } from "zustand";
import i18n from "../lib/i18n";
import { isTheme, type Theme } from "../lib/theme";

type Lang = "zh" | "en";

const isLang = (value: unknown): value is Lang => value === "zh" || value === "en";

/** ?theme= / ?lang= 白名单：非法值回落默认且不写 localStorage，并把它从 URL 里清掉（W5-02/W5-06）。 */
function readParam(key: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(key);
  } catch {
    return null;
  }
}

function stripSearchParam(key: string) {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(key)) return;
    url.searchParams.delete(key);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    /* 无 history 的环境（测试/老浏览器）忽略即可 */
  }
}

const printMode = window.location.hash.startsWith("#/briefing");

const queryTheme = readParam("theme");
const storedTheme = (() => {
  try {
    return localStorage.getItem("bl.theme");
  } catch {
    return null;
  }
})();
if (queryTheme !== null && !isTheme(queryTheme)) stripSearchParam("theme");
const initialTheme: Theme = printMode
  ? "light"
  : isTheme(queryTheme)
    ? queryTheme
    : isTheme(storedTheme)
      ? storedTheme
      : "dark";

const queryLang = readParam("lang");
const storedLang = (() => {
  try {
    return localStorage.getItem("bl.lang");
  } catch {
    return null;
  }
})();
if (queryLang !== null && !isLang(queryLang)) stripSearchParam("lang");
const initialLang: Lang = isLang(queryLang) ? queryLang : isLang(storedLang) ? storedLang : "zh";
const initialCb = (() => {
  try {
    return localStorage.getItem("bl.cb") === "1";
  } catch {
    return false;
  }
})();

/** 主题写 DOM；printMode 强制浅色但不覆盖用户平时的主题偏好。 */
export function applyTheme(theme: Theme, persist = true) {
  const safe = isTheme(theme) ? theme : "dark";
  document.documentElement.dataset.theme = safe;
  if (persist) {
    try {
      localStorage.setItem("bl.theme", safe);
    } catch {
      /* 隐私模式下 localStorage 可能不可写 */
    }
  }
}

export function applyColorblind(on: boolean) {
  document.documentElement.dataset.cb = on ? "1" : "0";
  try {
    localStorage.setItem("bl.cb", on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** <html lang> 必须跟随语言，否则屏幕阅读器会按中文读英文界面（W14-09）。 */
export function applyDocumentLang(lang: string) {
  document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
}

applyTheme(initialTheme, !printMode);
applyColorblind(initialCb);
applyDocumentLang(initialLang);

interface UIState {
  theme: Theme;
  lang: Lang;
  colorblind: boolean;
  toggleTheme: () => void;
  toggleColorblind: () => void;
  setLang: (l: Lang) => void;
}

export const useUI = create<UIState>((set, get) => ({
  theme: initialTheme,
  lang: initialLang,
  colorblind: initialCb,
  toggleTheme: () => {
    const next: Theme = get().theme === "dark" ? "light" : "dark";
    applyTheme(next);
    set({ theme: next });
  },
  toggleColorblind: () => {
    const next = !get().colorblind;
    applyColorblind(next);
    set({ colorblind: next });
  },
  setLang: (l) => {
    const safe: Lang = isLang(l) ? l : "zh";
    i18n.changeLanguage(safe);
    try {
      localStorage.setItem("bl.lang", safe);
    } catch {
      /* ignore */
    }
    applyDocumentLang(safe);
    set({ lang: safe });
  },
}));
