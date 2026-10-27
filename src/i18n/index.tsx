import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { strings, type Lang, type StringKey } from "./strings";

interface LanguageCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: StringKey, vars?: Record<string, string | number>) => string;
}

const Ctx = createContext<LanguageCtx | null>(null);

const STORAGE_KEY = "zeus.lang";

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "bn" || saved === "en") return saved;
  } catch {
    // storage unavailable
  }
  // Bangladesh-first audience
  return "bn";
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // storage unavailable
    }
    document.documentElement.lang = l === "bn" ? "bn" : "en";
  }, []);

  const t = useCallback(
    (key: StringKey, vars?: Record<string, string | number>) => {
      let out: string = strings[lang][key] ?? strings.en[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          out = out.replaceAll(`{${k}}`, String(v));
        }
      }
      return out;
    },
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  // Reflect language on <html> for font selection
  if (typeof document !== "undefined") {
    document.documentElement.lang = lang === "bn" ? "bn" : "en";
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLang(): LanguageCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLang must be used inside LanguageProvider");
  return ctx;
}

/** Small language toggle used in headers. */
export function LanguageToggle({ className = "" }: { className?: string }) {
  const { lang, setLang } = useLang();
  return (
    <button
      onClick={() => setLang(lang === "bn" ? "en" : "bn")}
      className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${className}`}
      title="Language / ভাষা"
    >
      {lang === "bn" ? "বাংলা" : "EN"}
    </button>
  );
}
