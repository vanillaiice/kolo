/**
 * The few visual decisions the whole app shares.
 *
 * Small on purpose. A design system is not the problem this project has; what
 * it needs is that a price is legible in a shop with the sun behind it, and
 * that the button a cashier hits fifty times an hour is where their thumb is.
 *
 * The sizes below are floors, not suggestions. §46 targets cheap Android
 * hardware, which in practice means small screens at low density held at arm's
 * length, and a 44pt touch target is the smallest a person hits reliably while
 * also serving a customer.
 */

import { Platform, type TextStyle } from "react-native";

export const colors = {
  background: "#FFFFFF",
  surface: "#F4F5F7",
  border: "#DCDFE4",
  text: "#14181F",
  muted: "#5C6672",
  /** Used for the one action a screen is for, and nothing else. */
  accent: "#0B7A4B",
  accentText: "#FFFFFF",
  /** Money leaving, a debt, anything the shopkeeper should read twice. */
  warning: "#B3261E",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

/**
 * The smallest a control may be.
 *
 * A cashier taps these while looking at a customer, not at the screen.
 */
export const TOUCH_TARGET = 48;

/**
 * Typed as `TextStyle` rather than inferred, so `fontVariant` is contextually
 * the mutable array React Native wants. An `as const` here would make it
 * readonly and every style that used it would stop compiling.
 */
export const type: {
  readonly title: TextStyle;
  readonly body: TextStyle;
  readonly label: TextStyle;
  readonly amount: TextStyle;
  readonly total: TextStyle;
  readonly mono: TextStyle;
} = {
  title: { fontSize: 20, fontWeight: "600" },
  body: { fontSize: 15 },
  label: { fontSize: 13, fontWeight: "600" },
  /** Prices, which are the thing being read across a counter. */
  amount: { fontSize: 18, fontWeight: "700", fontVariant: ["tabular-nums"] },
  /** The one figure the whole screen exists to show. */
  total: { fontSize: 32, fontWeight: "700", fontVariant: ["tabular-nums"] },
  mono: {
    fontSize: 12,
    fontFamily: Platform.select({ android: "monospace", default: "Menlo" }),
  },
};
