/**
 * The visual decisions the whole app shares, translated from the desktop tokens
 * (`apps/desktop/src/renderer/styles.css`): green primary actions and selection,
 * soft neutral-green canvas with white surfaces, clear borders, restrained rounding,
 * yellow attention and red destructive states, tabular figures for money.
 *
 * The sizes below are floors, not suggestions. §46 targets cheap Android hardware,
 * which in practice means small screens at low density held at arm's length.
 */

import { createContext, useContext } from "react";
import { Platform, type TextStyle } from "react-native";

/** Device appearance choice; "system" follows Android's light/dark setting. */
export type Appearance = "system" | "light" | "dark";

/** Semantic colours. Components name a role, never a hex value. */
export interface Palette {
  readonly canvas: string; readonly surface: string; readonly surfaceSoft: string; readonly border: string; readonly controlBorder: string;
  readonly text: string; readonly muted: string; readonly brand: string; readonly primary: string; readonly onPrimary: string;
  readonly selected: string; readonly selectedInk: string; readonly yellow: string; readonly yellowSoft: string; readonly yellowInk: string;
  readonly danger: string; readonly dangerSoft: string; readonly dangerBorder: string; readonly focus: string; readonly scrim: string;
  /** Fixed categorical order validated by the desktop for colour-vision separation; colour follows position. */
  readonly chart: readonly [string, string, string, string, string, string];
  readonly chartOther: string; readonly chartGrid: string;
}

export const light: Palette = {
  canvas: "#f4f7f3", surface: "#ffffff", surfaceSoft: "#edf4ef", border: "#cedbd2", controlBorder: "#7a9384",
  text: "#142b21", muted: "#465d50", brand: "#006c43", primary: "#00794b", onPrimary: "#ffffff",
  selected: "#dceee2", selectedInk: "#005632", yellow: "#f1c642", yellowSoft: "#fff2c5", yellowInk: "#735000",
  danger: "#b42339", dangerSoft: "#fff0f2", dangerBorder: "#e5a2ae", focus: "#926600", scrim: "#061d14a6",
  chart: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"], chartOther: "#a5b0a9", chartGrid: "#e6ece8",
};

export const dark: Palette = {
  canvas: "#1f2b25", surface: "#27362e", surfaceSoft: "#2e4036", border: "#4a6153", controlBorder: "#7f9887",
  text: "#eef6f0", muted: "#c0d2c5", brand: "#7fe3b0", primary: "#7cdcaa", onPrimary: "#0d2a1c",
  selected: "#2f5541", selectedInk: "#b0f0cd", yellow: "#f5ce52", yellowSoft: "#4a3f22", yellowInk: "#ffde7a",
  danger: "#ff9aa7", dangerSoft: "#4a2a33", dangerBorder: "#b46b7c", focus: "#f5ce52", scrim: "#0a140fb0",
  chart: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"], chartOther: "#6d7d73", chartGrid: "#33453b",
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
/** Desktop uses 8 px controls and 12 px panels; mobile keeps the same restraint. */
export const radius = { control: 8, panel: 12 } as const;

/**
 * The smallest a control may be. A cashier taps these while looking at a customer,
 * not at the screen.
 */
export const TOUCH_TARGET = 48;
/** Widths from here use a side rail and side-by-side list/detail. */
export const WIDE_LAYOUT = 600;

/**
 * Typed as `TextStyle` rather than inferred, so `fontVariant` is contextually the mutable
 * array React Native wants. System fonts only: a bundled font must justify its size.
 */
export const type: {
  readonly title: TextStyle; readonly heading: TextStyle; readonly body: TextStyle; readonly small: TextStyle;
  readonly label: TextStyle; readonly amount: TextStyle; readonly total: TextStyle; readonly mono: TextStyle; readonly eyebrow: TextStyle;
} = {
  title: { fontSize: 22, fontWeight: "700", letterSpacing: -0.3 },
  heading: { fontSize: 17, fontWeight: "600" },
  body: { fontSize: 15, lineHeight: 22 },
  small: { fontSize: 13, lineHeight: 19 },
  label: { fontSize: 13, fontWeight: "600" },
  eyebrow: { fontSize: 11, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" },
  /** Prices, which are the thing being read across a counter. */
  amount: { fontSize: 16, fontWeight: "700", fontVariant: ["tabular-nums"] },
  /** The one figure the whole screen exists to show. */
  total: { fontSize: 30, fontWeight: "700", fontVariant: ["tabular-nums"], letterSpacing: -0.5 },
  mono: { fontSize: 13, fontFamily: Platform.select({ android: "monospace", default: "Menlo" }) },
};

/** The resolved palette and scheme for the current appearance. */
export interface Theme { readonly colors: Palette; readonly scheme: "light" | "dark" }
export const ThemeContext = createContext<Theme>({ colors: light, scheme: "light" });
/** Resolves a saved appearance against the device's colour scheme. */
export function resolveTheme(appearance: Appearance, system: string | null | undefined): Theme {
  const scheme = appearance === "system" ? system === "dark" ? "dark" : "light" : appearance;
  return { colors: scheme === "dark" ? dark : light, scheme };
}
/** The current theme; components read colours here instead of importing a fixed palette. */
export function useTheme(): Theme { return useContext(ThemeContext); }
