import { Children, createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { AccessibilityInfo, ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Switch, Text, TextInput, View,
  type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { KeyboardAvoidingView, KeyboardAwareScrollView, KeyboardStickyView } from "react-native-keyboard-controller";
import type { Cursor, Page, PageQuery } from "@kolo/core/application/queries";
import Animated from "react-native-reanimated";
import { useText } from "../app/i18n.tsx";
import { AnimatedPressable, appear, disappear, rise, useColorTransition, usePressMotion } from "./motion.ts";
import { radius, spacing, TOUCH_TARGET, type as typography, useTheme, type Palette } from "./theme.ts";

/** Styles derived from the current palette; memoized per palette so screens do not rebuild them every render. */
export function useStyles(): ReturnType<typeof makeStyles> {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}
function makeStyles(c: Palette) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xl * 2 },
    title: { ...typography.title, color: c.text },
    heading: { ...typography.heading, color: c.text },
    body: { ...typography.body, color: c.text },
    muted: { ...typography.small, color: c.muted },
    eyebrow: { ...typography.eyebrow, color: c.muted },
    amount: { ...typography.amount, color: c.text },
    total: { ...typography.total, color: c.text },
    mono: { ...typography.mono, color: c.text },
    danger: { color: c.danger },
    panel: { backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: radius.panel, padding: spacing.lg, gap: spacing.md },
    row: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
    between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
    input: { minHeight: TOUCH_TARGET, borderWidth: 1, borderColor: c.controlBorder, borderRadius: radius.control, paddingHorizontal: spacing.md, paddingVertical: 10,
      color: c.text, backgroundColor: c.surface, fontSize: 16 },
  });
}

/** Space kept between a focused input and the keyboard (or footer): enough for a two-line description under it. */
const DESCRIPTION_ROOM = spacing.xl * 2 + spacing.sm;

/** Height of what sits under screens (the bottom tab bar on phones), which the keyboard covers first. */
export const BelowScreenContext = createContext(0);

/** Header with an optional Back control, then scrollable content and a footer kept above the keyboard. */
export function Screen({ title, eyebrow, onBack, actions, children, footer, scroll = true, testID }: {
  readonly title: string; readonly eyebrow?: string | undefined; readonly onBack?: (() => void) | undefined; readonly actions?: ReactNode;
  readonly children: ReactNode; readonly footer?: ReactNode; readonly scroll?: boolean; readonly testID?: string;
}): React.JSX.Element {
  const s = useStyles(), { colors } = useTheme(), { t } = useText(), [footerHeight, setFooterHeight] = useState(0), below = useContext(BelowScreenContext);
  // A focused field in the scroll area scrolls clear of the keyboard and the footer, with room for its description
  // or error underneath; the footer rides on the keyboard (less whatever already sits below the screen, such as the
  // tab bar). Lists shrink above the keyboard.
  return <View style={s.screen} testID={testID}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        {onBack !== undefined && <Pressable accessibilityRole="button" accessibilityLabel={t("back")} onPress={onBack} hitSlop={8}
          style={{ minWidth: TOUCH_TARGET, minHeight: TOUCH_TARGET, justifyContent: "center", marginLeft: -spacing.sm, paddingLeft: spacing.sm }}><Text style={{ fontSize: 30, lineHeight: 34, color: colors.primary }}>‹</Text></Pressable>}
        <View style={{ flex: 1, paddingVertical: spacing.xs }}>{eyebrow !== undefined && <Text style={s.eyebrow}>{eyebrow}</Text>}
          <Text accessibilityRole="header" style={s.title}>{title}</Text></View>
        {actions}
      </View>
      {scroll ? <KeyboardAwareScrollView style={{ flex: 1 }} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" bottomOffset={footerHeight + DESCRIPTION_ROOM}>{children}</KeyboardAwareScrollView>
        : <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">{children}</KeyboardAvoidingView>}
      {footer !== undefined && footer !== null && footer !== false && <KeyboardStickyView offset={{ closed: 0, opened: below }}>
        <View onLayout={event => setFooterHeight(event.nativeEvent.layout.height)} style={{ padding: spacing.md, gap: spacing.sm, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border }}>{footer}</View>
      </KeyboardStickyView>}
  </View>;
}

/** A safe-area page for screens shown outside the operational shell (entry, recovery). */
export function Page({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const s = useStyles();
  return <SafeAreaView edges={["top", "bottom"]} style={s.screen}>{children}</SafeAreaView>;
}

type Variant = "primary" | "secondary" | "danger" | "ghost";
/** Accessible button with a 48 dp target; `busy` blocks repeats, and the pressed button shows the spinner. */
export function Button({ label, onPress, variant = "primary", disabled = false, busy = false, style, hint, accessibilityLabel }: {
  readonly label: string; readonly onPress: () => void; readonly variant?: Variant; readonly disabled?: boolean; readonly busy?: boolean;
  readonly style?: StyleProp<ViewStyle>; readonly hint?: string; readonly accessibilityLabel?: string;
}): React.JSX.Element {
  const { colors } = useTheme(), off = disabled || busy;
  // Several buttons often share one action's busy flag: only the one pressed shows the spinner, the rest are just disabled.
  const [pressed, setPressed] = useState(false);
  useEffect(() => { if (!busy) setPressed(false); }, [busy]);
  const spinning = busy && pressed;
  const look: Record<Variant, { bg: string; border: string; ink: string }> = {
    primary: { bg: colors.primary, border: colors.primary, ink: colors.onPrimary },
    secondary: { bg: colors.surface, border: colors.controlBorder, ink: colors.text },
    danger: { bg: colors.dangerSoft, border: colors.dangerBorder, ink: colors.danger },
    ghost: { bg: "transparent", border: "transparent", ink: colors.primary },
  };
  const v = look[variant], press = usePressMotion(spinning ? 1 : off ? 0.5 : 1);
  return <AnimatedPressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} accessibilityHint={hint} accessibilityState={{ disabled: off, busy: spinning }} disabled={off}
    onPress={() => { setPressed(true); onPress(); }} onPressIn={press.onPressIn} onPressOut={press.onPressOut}
    style={[{ minHeight: TOUCH_TARGET, borderRadius: radius.control, borderWidth: 1, borderColor: v.border, backgroundColor: v.bg, paddingHorizontal: spacing.lg,
      paddingVertical: 10, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: spacing.sm }, style, press.style]}>
    {spinning && <ActivityIndicator color={v.ink} />}<Text style={{ color: v.ink, fontSize: 16, fontWeight: "600", textAlign: "center", flexShrink: 1 }}>{label}</Text>
  </AnimatedPressable>;
}

/** Field input kinds: money is whole francs, quantity accepts decimals, secret hides input. */
export type FieldKind = "text" | "money" | "quantity" | "secret" | "phone" | "code" | "date";
/**
 * Visible label stays available while typing, including hardware-keyboard input. Every field says what it is for:
 * `hint` is required, and `null` marks the rare field whose label and context already say everything (search boxes,
 * inline quantities whose row is the description).
 */
export function Field({ label, value, onChange, kind = "text", hint, error, onSubmit, autoFocus, inputRef, placeholder, editable = true, multiline = false, labelHidden = false }: {
  readonly label: string; readonly value: string; readonly onChange: (value: string) => void; readonly kind?: FieldKind; readonly hint: string | null;
  readonly error?: string | undefined; readonly onSubmit?: (() => void) | undefined; readonly autoFocus?: boolean; readonly inputRef?: Ref<TextInput>;
  readonly placeholder?: string | undefined; readonly editable?: boolean; readonly multiline?: boolean;
  /** For inline rows whose label sits above the whole row: the label is still read by screen readers. */
  readonly labelHidden?: boolean;
}): React.JSX.Element {
  const s = useStyles(), { colors } = useTheme();
  const keyboard = kind === "money" ? "number-pad" : kind === "quantity" ? "decimal-pad" : kind === "phone" ? "phone-pad" : "default";
  const { t } = useText(), [shown, setShown] = useState(false), secret = kind === "secret";
  const input = <TextInput ref={inputRef} accessibilityLabel={label} accessibilityHint={error ?? hint ?? undefined} value={value} onChangeText={onChange} keyboardType={keyboard}
      secureTextEntry={secret && !shown} autoCapitalize={kind === "text" ? "sentences" : "none"} autoCorrect={false} autoFocus={autoFocus} editable={editable}
      placeholder={placeholder ?? (kind === "date" ? "AAAA-MM-JJ" : undefined)} placeholderTextColor={colors.muted} multiline={multiline}
      onSubmitEditing={onSubmit} submitBehavior={multiline ? "newline" : onSubmit ? "submit" : "blurAndSubmit"}
      style={[s.input, (kind === "money" || kind === "quantity") && { fontVariant: ["tabular-nums"] }, error !== undefined && { borderColor: colors.danger }, !editable && { opacity: 0.6 },
        secret && { flex: 1, paddingRight: 96 }]} />;
  return <View style={{ gap: 6 }}>
    {!labelHidden && <Text style={{ ...typography.label, color: colors.muted }}>{label}</Text>}
    {secret ? <View style={{ flexDirection: "row", alignItems: "center" }}>{input}
      {/* Show/hide the typed code or password; it stays hidden by default. */}
      <Pressable accessibilityRole="button" accessibilityLabel={t(shown ? "hideSecretLabel" : "showSecretLabel", { field: label })} accessibilityState={{ checked: shown }}
        onPress={() => setShown(value => !value)} hitSlop={4}
        style={{ position: "absolute", right: 0, minHeight: TOUCH_TARGET, minWidth: 88, paddingHorizontal: spacing.md, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: colors.primary, fontWeight: "600", fontSize: 14 }}>{t(shown ? "hideSecret" : "showSecret")}</Text>
      </Pressable></View> : input}
    <Description hint={hint} error={error} />
  </View>;
}

/** A control's description under it; an error takes its place and fades in so the change is noticed. */
function Description({ hint, error }: { readonly hint: string | null | undefined; readonly error?: string | undefined }): React.JSX.Element | null {
  const s = useStyles(), { colors } = useTheme();
  if (error !== undefined) return <Animated.Text key={error} entering={appear} style={{ ...typography.small, color: colors.danger }}>{error}</Animated.Text>;
  return hint === null || hint === undefined ? null : <Text style={s.muted}>{hint}</Text>;
}

/** A labelled switch with a full-width touch target and, like every field, a description (`null` only when the label says it all). */
export function Toggle({ label, value, onChange, hint }: { readonly label: string; readonly value: boolean; readonly onChange: (value: boolean) => void; readonly hint: string | null }): React.JSX.Element {
  const s = useStyles(), { colors } = useTheme();
  return <Pressable accessibilityRole="switch" accessibilityState={{ checked: value }} accessibilityLabel={label} accessibilityHint={hint ?? undefined} onPress={() => onChange(!value)}
    style={{ minHeight: TOUCH_TARGET, flexDirection: "row", alignItems: "center", gap: spacing.md }}>
    <View style={{ flex: 1, gap: 2 }}><Text style={s.body}>{label}</Text>{hint !== null && <Text style={s.muted}>{hint}</Text>}</View>
    <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.primary, false: colors.border }} thumbColor={colors.surface} importantForAccessibility="no" />
  </Pressable>;
}

/**
 * Mutually exclusive choices shown as a wrapping segmented control. A labelled one is a form field and carries a
 * description like the others; an unlabelled one switches views (tabs, steps) and has neither.
 */
export function Segmented<T extends string>({ label, hint, value, options, onChange }: ({ readonly label: string; readonly hint: string | null } | { readonly label?: undefined; readonly hint?: undefined }) & {
  readonly value: T | undefined; readonly options: readonly { readonly id: T; readonly label: string }[]; readonly onChange: (value: T) => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  return <View style={{ gap: 6 }} accessibilityRole="radiogroup" accessibilityLabel={label}>
    {label !== undefined && <Text style={{ ...typography.label, color: colors.muted }}>{label}</Text>}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>{options.map(option =>
      <SegmentOption key={option.id} label={option.label} on={option.id === value} onPress={() => onChange(option.id)} />)}</View>
    <Description hint={hint} />
  </View>;
}
function SegmentOption({ label, on, onPress }: { readonly label: string; readonly on: boolean; readonly onPress: () => void }): React.JSX.Element {
  const { colors } = useTheme(), press = usePressMotion(), transition = useColorTransition();
  return <AnimatedPressable accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={label} onPress={onPress} onPressIn={press.onPressIn} onPressOut={press.onPressOut}
    style={[{ minHeight: TOUCH_TARGET, paddingHorizontal: spacing.md, justifyContent: "center", borderRadius: radius.control, borderWidth: 1,
      borderColor: on ? colors.primary : colors.controlBorder, backgroundColor: on ? colors.selected : colors.surface, ...transition }, press.style]}>
    <Text style={{ color: on ? colors.selectedInk : colors.text, fontWeight: on ? "700" : "400", fontSize: 15 }}>{label}</Text>
  </AnimatedPressable>;
}

/** Tappable list row: title, optional subtitle and trailing figure; the whole row is the target. */
export function ListRow({ title, subtitle, trailing, trailingTone = "normal", onPress, leading, tag, accessibilityLabel }: {
  readonly title: string; readonly subtitle?: string | undefined; readonly trailing?: string | undefined; readonly trailingTone?: "normal" | "danger" | "muted";
  readonly onPress?: (() => void) | undefined; readonly leading?: ReactNode; readonly tag?: string | undefined; readonly accessibilityLabel?: string;
}): React.JSX.Element {
  const s = useStyles(), { colors } = useTheme();
  const body = <>
    {leading}
    <View style={{ flex: 1, gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}><Text style={[s.body, { fontWeight: "600" }]}>{title}</Text>{tag !== undefined && <Tag text={tag} />}</View>
      {subtitle !== undefined && subtitle !== "" && <Text style={s.muted}>{subtitle}</Text>}
    </View>
    {trailing !== undefined && <Text style={[s.amount, { textAlign: "right", flexShrink: 0, maxWidth: "45%" }, trailingTone === "danger" && s.danger, trailingTone === "muted" && { color: colors.muted }]}>{trailing}</Text>}
    {onPress !== undefined && <Text style={{ color: colors.muted, fontSize: 20 }} importantForAccessibility="no">›</Text>}
  </>;
  const style: ViewStyle = { minHeight: TOUCH_TARGET + 8, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    backgroundColor: colors.surface };
  const label = accessibilityLabel ?? [title, tag, subtitle, trailing].filter(Boolean).join(", ");
  return onPress === undefined ? <View style={style} accessible accessibilityLabel={label}>{body}</View>
    : <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} android_ripple={{ color: colors.selected }}
      style={({ pressed }) => [style, pressed && { backgroundColor: colors.surfaceSoft }]}>{body}</Pressable>;
}

/** Hairline between rows; lists draw it between items only, never after the last one. */
export function Divider(): React.JSX.Element {
  const { colors } = useTheme();
  return <View importantForAccessibility="no" style={{ height: 1, backgroundColor: colors.border }} />;
}

/** A rounded group of rows (menus, short lists) with dividers between rows only. */
export function RowGroup({ children, title }: { readonly children: ReactNode; readonly title?: string }): React.JSX.Element | null {
  const s = useStyles(), { colors } = useTheme();
  // toArray already drops null, undefined and booleans.
  const rows = Children.toArray(children).filter(child => child !== "");
  if (rows.length === 0) return null;
  return <View style={{ gap: spacing.sm }}>
    {title !== undefined && <Text accessibilityRole="header" style={s.heading}>{title}</Text>}
    <View style={{ borderRadius: radius.panel, overflow: "hidden", borderWidth: 1, borderColor: colors.border }}>
      {rows.map((row, index) => <Fragment key={index}>{index > 0 && <Divider />}{row}</Fragment>)}
    </View>
  </View>;
}

/** Small yellow label for states such as "Archived". */
export function Tag({ text, tone = "attention" }: { readonly text: string; readonly tone?: "attention" | "danger" | "selected" }): React.JSX.Element {
  const { colors } = useTheme();
  const look = tone === "danger" ? [colors.dangerSoft, colors.danger] : tone === "selected" ? [colors.selected, colors.selectedInk] : [colors.yellowSoft, colors.yellowInk];
  return <Text style={{ backgroundColor: look[0], color: look[1], fontSize: 12, fontWeight: "600", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, overflow: "hidden" }}>{text}</Text>;
}

/** Status text announced to screen readers; errors are never colour-only. */
/**
 * A long step in progress: the native spinner keeps turning while JavaScript is busy (a backup check
 * runs synchronously), so the screen never looks frozen. Announced once for screen readers.
 */
export function Working({ text }: { readonly text: string }): React.JSX.Element {
  const { colors } = useTheme();
  useEffect(() => { AccessibilityInfo.announceForAccessibility(text); }, [text]);
  return <Animated.View entering={appear} exiting={disappear} accessibilityRole="progressbar" accessibilityLabel={text} accessibilityLiveRegion="polite"
    style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, backgroundColor: colors.surfaceSoft, borderColor: colors.border, borderWidth: 1, borderRadius: radius.control, padding: spacing.md }}>
    <ActivityIndicator size="large" color={colors.primary} /><Text style={{ ...typography.small, color: colors.text, flex: 1 }}>{text}</Text>
  </Animated.View>;
}

/** Resolves after the next frame is drawn, so a status shown just before synchronous work is on screen. */
export function nextPaint(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/** A message in its tone's colours; it fades in when it appears, and success and error are announced. */
export function Notice({ tone = "info", text, action }: { readonly tone?: "info" | "success" | "warning" | "error"; readonly text: string; readonly action?: ReactNode }): React.JSX.Element {
  const { colors } = useTheme();
  const look = { info: [colors.surfaceSoft, colors.text, colors.border], success: [colors.selected, colors.selectedInk, colors.selected], warning: [colors.yellowSoft, colors.yellowInk, colors.yellow],
    error: [colors.dangerSoft, colors.danger, colors.dangerBorder] }[tone];
  useEffect(() => { if (tone === "error" || tone === "success") AccessibilityInfo.announceForAccessibility(text); }, [text, tone]);
  return <Animated.View entering={appear} exiting={disappear} accessibilityRole={tone === "error" ? "alert" : "text"} accessibilityLiveRegion="polite"
    style={{ backgroundColor: look[0], borderColor: look[2], borderWidth: 1, borderRadius: radius.control, padding: spacing.md, gap: spacing.sm }}>
    <Text style={{ ...typography.small, color: look[1] }}>{text}</Text>{action}
  </Animated.View>;
}

/** Empty list or missing record, with an optional next step. */
export function EmptyState({ title, text, action }: { readonly title: string; readonly text?: string | undefined; readonly action?: ReactNode }): React.JSX.Element {
  const s = useStyles();
  return <Animated.View entering={appear} style={{ alignItems: "center", padding: spacing.xl, gap: spacing.sm }}><Text style={[s.heading, { textAlign: "center" }]}>{title}</Text>
    {text !== undefined && <Text style={[s.muted, { textAlign: "center" }]}>{text}</Text>}{action}</Animated.View>;
}

/** A titled panel grouping related fields or facts. */
export function Section({ title, children, style }: { readonly title?: string; readonly children: ReactNode; readonly style?: StyleProp<ViewStyle> }): React.JSX.Element {
  const s = useStyles();
  return <View style={[s.panel, style]}>{title !== undefined && <Text accessibilityRole="header" style={s.heading}>{title}</Text>}{children}</View>;
}

/** Label/value pairs; values wrap instead of overlapping at large text sizes. */
export function Facts({ items }: { readonly items: readonly (readonly [string, string | undefined, ("danger" | "strong" | undefined)?])[] }): React.JSX.Element {
  const s = useStyles();
  return <View style={{ gap: spacing.sm }}>{items.filter(([, value]) => value !== undefined && value !== "").map(([label, value, tone]) =>
    <View key={label} style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: spacing.sm }} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={s.muted}>{label}</Text><Text style={[s.body, { fontVariant: ["tabular-nums"], flexShrink: 1, textAlign: "right" }, tone === "danger" && s.danger, tone === "strong" && { fontWeight: "700" }]}>{value}</Text>
    </View>)}</View>;
}

/** A headline figure with its label, used for totals and report tiles. */
export function Stat({ label, value, note, tone }: { readonly label: string; readonly value: string; readonly note?: string | undefined; readonly tone?: "danger" | undefined }): React.JSX.Element {
  const s = useStyles(), { colors } = useTheme();
  return <View accessible accessibilityLabel={`${label}: ${value}${note ? `, ${note}` : ""}`} style={{ flexGrow: 1, flexBasis: 140, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.panel, padding: spacing.md, gap: 4 }}>
    <Text style={[s.muted, { fontWeight: "600" }]}>{label}</Text><Text style={[s.amount, { fontSize: 20 }, tone === "danger" && s.danger]}>{value}</Text>{note !== undefined && <Text style={s.muted}>{note}</Text>}
  </View>;
}

/** Confirmation dialog; `typed` requires the user to type an exact text, such as the shop name, before confirming. */
export function Confirm({ visible, title, text, confirmLabel, onConfirm, onCancel, destructive = false, typed }: {
  readonly visible: boolean; readonly title: string; readonly text?: string | undefined; readonly confirmLabel: string; readonly onConfirm: () => void; readonly onCancel: () => void;
  readonly destructive?: boolean; readonly typed?: { readonly label: string; readonly expected: string; readonly hint?: string } | undefined;
}): React.JSX.Element {
  const s = useStyles(), { colors } = useTheme(), { t } = useText(), [entry, setEntry] = useState("");
  useEffect(() => { if (!visible) setEntry(""); }, [visible]);
  const ready = typed === undefined || entry.trim() === typed.expected;
  // Edge-to-edge modals: on Android the keyboard controller can only follow the keyboard in a translucent window.
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent navigationBarTranslucent>
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.scrim, justifyContent: "center", padding: spacing.lg }}>
      <Animated.View entering={rise} accessibilityViewIsModal style={[s.panel, { gap: spacing.md }]}>
        <Text accessibilityRole="header" style={s.heading}>{title}</Text>{text !== undefined && <Text style={s.body}>{text}</Text>}
        {typed !== undefined && <Field label={typed.label} value={entry} onChange={setEntry} autoFocus hint={typed.hint ?? t("hint.typedConfirm", { text: typed.expected })} />}
        <Button label={confirmLabel} variant={destructive ? "danger" : "primary"} disabled={!ready} onPress={onConfirm} />
        <Button label={t("cancel")} variant="secondary" onPress={onCancel} />
      </Animated.View>
    </KeyboardAvoidingView>
  </Modal>;
}

/** Bottom sheet with its own Back handling; Android Back closes it first. */
export function Sheet({ visible, title, onClose, children }: { readonly visible: boolean; readonly title: string; readonly onClose: () => void; readonly children: ReactNode }): React.JSX.Element {
  const s = useStyles(), { colors } = useTheme(), { t } = useText();
  // The sheet shrinks above the keyboard rather than sliding under it: everything below the header may give up height.
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
    <View style={{ flex: 1, backgroundColor: colors.scrim, justifyContent: "flex-end" }}>
      <KeyboardAvoidingView behavior="padding" style={{ maxHeight: "92%" }}>
        <SafeAreaView edges={["bottom"]} accessibilityViewIsModal style={{ flexShrink: 1, backgroundColor: colors.canvas, borderTopLeftRadius: radius.panel, borderTopRightRadius: radius.panel, overflow: "hidden" }}>
          <View style={[s.between, { padding: spacing.lg, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border }]}>
            <Text accessibilityRole="header" style={[s.heading, { flex: 1 }]}>{title}</Text><Button label={t("close")} variant="ghost" onPress={onClose} /></View>
          <View style={{ flexShrink: 1 }}>{children}</View>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </View>
  </Modal>;
}

/** Debounces human typing; scanner input bypasses this through explicit submit. */
export function useDebounced<T>(value: T, delay = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setSettled(value), delay); return () => clearTimeout(timer); }, [value, delay]);
  return settled;
}

/** Most pages a list keeps loaded (30 rows each by default); beyond this the user refines the search. */
export const MAX_PAGES = 10;
/**
 * Bounded keyset paging. Loaded pages are re-read from the start when `revision` changes so a list
 * keeps its position after a commit without trusting a stale cursor; at most {@link MAX_PAGES} pages.
 */
export function usePages<T>(load: (query: PageQuery) => Page<T>, deps: readonly unknown[], revision: string): { items: readonly T[]; more: boolean; capped: boolean; failed: boolean; loadMore: () => void; retry: () => void } {
  const [pages, setPages] = useState(1), [attempt, setAttempt] = useState(0);
  const key = JSON.stringify(deps);
  const previous = useRef(key);
  if (previous.current !== key) { previous.current = key; if (pages !== 1) setPages(1); }
  const result = useMemo(() => {
    const items: T[] = []; let after: Cursor | undefined; let next = false;
    try {
      for (let index = 0; index < pages; index++) {
        const page = load(after === undefined ? {} : { after });
        items.push(...page.items); after = page.next; next = page.next !== undefined;
        if (!next) break;
      }
      return { items, more: next, failed: false };
    } catch { return { items, more: false, failed: true }; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, revision, pages, attempt]);
  return { ...result, more: result.more && pages < MAX_PAGES, capped: result.more && pages >= MAX_PAGES,
    loadMore: () => { if (result.more && pages < MAX_PAGES) setPages(value => value + 1); }, retry: () => setAttempt(value => value + 1) };
}

/** Search box above a bounded, virtualized list with stable keys. */
export function PagedList<T>({ load, revision, identify, render, header, empty, searchable = true, searchLabel, deps = [] }: {
  readonly load: (query: PageQuery) => Page<T>; readonly revision: string; readonly identify: (item: T) => string; readonly render: (item: T) => React.JSX.Element;
  readonly header?: ReactNode; readonly empty?: { readonly title: string; readonly text?: string; readonly action?: ReactNode }; readonly searchable?: boolean;
  readonly searchLabel?: string; readonly deps?: readonly unknown[];
}): React.JSX.Element {
  const { t } = useText(), s = useStyles(), [term, setTerm] = useState(""), query = useDebounced(term.trim());
  const pages = usePages(page => load({ ...page, ...(query === "" ? {} : { term: query }) }), [query, ...deps], revision);
  return <FlatList data={pages.items} keyExtractor={identify} renderItem={({ item }) => render(item)} style={s.screen} keyboardShouldPersistTaps="handled" ItemSeparatorComponent={Divider}
    initialNumToRender={12} maxToRenderPerBatch={12} windowSize={7} removeClippedSubviews onEndReachedThreshold={0.5} onEndReached={pages.loadMore}
    ListHeaderComponent={<View style={{ padding: spacing.lg, gap: spacing.md }}>{header}
      {searchable && <Field label={searchLabel ?? t("search")} value={term} onChange={setTerm} hint={null} />}</View>}
    ListEmptyComponent={pages.failed ? <View style={{ padding: spacing.lg }}><Notice tone="error" text={t("loadFailed")} action={<Button label={t("retry")} variant="secondary" onPress={pages.retry} />} /></View>
      : <EmptyState title={query !== "" ? t("noMatches") : empty?.title ?? t("empty")} text={query !== "" ? undefined : empty?.text} action={query !== "" ? undefined : empty?.action} />}
    ListFooterComponent={<View style={{ padding: spacing.lg, gap: spacing.sm }}>
      {pages.failed && pages.items.length > 0 && <Notice tone="error" text={t("loadFailed")} action={<Button label={t("retry")} variant="secondary" onPress={pages.retry} />} />}
      {pages.more && <Button label={t("more")} variant="secondary" onPress={pages.loadMore} />}
      {pages.capped && <Text style={[s.muted, { textAlign: "center" }]}>{t("refineSearch")}</Text>}
    </View>} />;
}

/** Searchable local chooser in a sheet; shows bounded pages and keeps the chosen label visible. */
export function Picker<T extends { readonly id: string; readonly name: string }>({ label, hint, value, onChange, load, revision, optional = false, describe, placeholder, create }: {
  /** What the choice is for, shown under it like every field's description; `null` only when the label says it all. */
  readonly label: string; readonly hint: string | null; readonly value: T | undefined; readonly onChange: (value: T | undefined) => void; readonly load: (query: PageQuery) => Page<T>;
  readonly revision: string; readonly optional?: boolean; readonly describe?: (item: T) => string | undefined; readonly placeholder?: string;
  /**
   * Lets the sheet create the item it lacks: `add` records it and calls `select` with the stored item,
   * which is then chosen. `notice` shows the caller's outcome inside the sheet.
   */
  readonly create?: { readonly label: string; readonly hint: string | null; readonly add: (name: string, select: (item: T) => void) => void; readonly notice?: React.ReactNode } | undefined;
}): React.JSX.Element {
  const { t } = useText(), s = useStyles(), { colors } = useTheme(), [open, setOpen] = useState(false), [draft, setDraft] = useState("");
  const add = (): void => create?.add(draft, item => { onChange(item); setDraft(""); setOpen(false); });
  return <View style={{ gap: 6 }}>
    <Text style={{ ...typography.label, color: colors.muted }}>{label}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${value?.name ?? placeholder ?? t("none")}`} accessibilityHint={hint === null ? t("opensChooser") : `${hint} ${t("opensChooser")}`} onPress={() => setOpen(true)}
      android_ripple={{ color: colors.selected }} style={({ pressed }) => [s.input, { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, pressed && { backgroundColor: colors.surfaceSoft }]}>
      <Text style={[s.body, value === undefined && { color: colors.muted }]}>{value?.name ?? placeholder ?? t("choose")}</Text><Text style={{ color: colors.muted }}>▾</Text>
    </Pressable>
    <Description hint={hint} />
    <Sheet visible={open} title={label} onClose={() => setOpen(false)}>
      {/* Creating sits above the list, where the keyboard never covers it; the list gives up height instead. */}
      {open && create !== undefined && <View style={{ gap: spacing.sm, padding: spacing.lg, paddingBottom: 0 }}>
        <Field label={create.label} value={draft} onChange={setDraft} onSubmit={add} hint={create.hint} />
        {create.notice}<Button label={t("add")} variant="secondary" disabled={draft.trim() === ""} onPress={add} /></View>}
      {open && <View style={{ height: 480, flexShrink: 1, minHeight: 140 }}><PagedList<T> load={load} revision={revision} identify={item => item.id}
        header={optional ? <Button label={t("none")} variant="secondary" onPress={() => { onChange(undefined); setOpen(false); }} /> : undefined}
        render={item => <ListRow title={item.name} subtitle={describe?.(item)} tag={item.id === value?.id ? t("selected") : undefined} onPress={() => { onChange(item); setOpen(false); }} />} /></View>}
    </Sheet>
  </View>;
}

