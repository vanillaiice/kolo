import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackHandler, Pressable, Text, View, useWindowDimensions } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { ActiveContext, usePermissions } from "../../app/session.tsx";
import { availableTabs } from "../../app/destinations.ts";
import { GuardContext, NavigationContext, RouteContext, type Navigation, type Route, type RouteMap, type RouteName, type Tab } from "../../app/navigation.tsx";
import { useText, type TextKey } from "../../app/i18n.tsx";
import { spacing, TOUCH_TARGET, useTheme, WIDE_LAYOUT } from "../../components/theme.ts";
import { BelowScreenContext, Confirm } from "../../components/ui.tsx";
import { DETAIL_ROUTES, SCREENS } from "./routes.tsx";

const TAB_LABEL: Record<Tab, TextKey> = { sell: "tab.sell", products: "tab.products", activity: "tab.activity", more: "tab.more" };
const TAB_GLYPH: Record<Tab, string> = { sell: "⊕", products: "▦", activity: "≡", more: "⋯" };
let sequence = 0;
const route = <K extends RouteName>(name: K, params: RouteMap[K]): Route => ({ key: `${name}-${++sequence}`, name, params }) as Route;

/**
 * Operational shell: four destinations (bottom bar on phones, side rail from 600 dp) each with a
 * list → detail → action stack. Hidden stack screens stay mounted to keep search and scroll, but
 * freeze their queries. Back closes sheets (handled by the sheet), pops the stack with a discard
 * check, returns to the landing destination, then leaves the app.
 */
export function Shell(): React.JSX.Element {
  const { t } = useText(), { colors } = useTheme(), permissions = usePermissions(), { width, fontScale } = useWindowDimensions();
  const tabs = availableTabs(permissions), landing = tabs[0]!, bottomInset = useSafeAreaInsets().bottom;
  const [selected, setSelected] = useState<Tab>(landing);
  const tab = tabs.includes(selected) ? selected : landing;
  const [stacks, setStacks] = useState<Record<Tab, readonly Route[]>>(() => ({ sell: [route("sell", undefined)], products: [route("products", undefined)], activity: [route("activity", undefined)], more: [route("more", undefined)] }));
  const guards = useRef(new Map<string, boolean>());
  const [pendingLeave, setPendingLeave] = useState<(() => void) | undefined>(undefined), [barHeight, setBarHeight] = useState(0);
  const wide = width / Math.max(1, Math.min(fontScale, 1.6)) >= WIDE_LAYOUT;
  const stack = stacks[tab];

  const guarded = useCallback((key: string | undefined, leave: () => void): void => {
    if (key !== undefined && guards.current.get(key) === true) setPendingLeave(() => leave); else leave();
  }, []);
  const navigation = useMemo<Navigation>(() => {
    const update = (change: (current: readonly Route[]) => readonly Route[]): void => setStacks(current => ({ ...current, [tab]: change(current[tab]) }));
    const pop = (): void => update(current => current.length > 1 ? current.slice(0, -1) : current);
    return {
      tab,
      push: (name, ...params) => update(current => [...current, route(name, params[0] as RouteMap[typeof name])]),
      replace: (name, ...params) => update(current => [...current.slice(0, -1), route(name, params[0] as RouteMap[typeof name])]),
      back: () => {
        const top = stacks[tab].at(-1);
        if (stacks[tab].length > 1) guarded(top?.key, pop);
        else if (tab !== landing) setSelected(landing);
      },
      leave: pop,
      open: next => { setSelected(next); setStacks(current => ({ ...current, [next]: current[next].slice(0, 1) })); },
      popTo: name => update(current => { const index = current.map(item => item.name).lastIndexOf(name); return index < 0 ? current.slice(0, 1) : current.slice(0, index + 1); }),
    };
  }, [tab, stacks, landing, guarded]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (pendingLeave !== undefined) { setPendingLeave(undefined); return true; }
      if (stack.length > 1 || tab !== landing) { navigation.back(); return true; }
      return false;
    });
    return () => subscription.remove();
  }, [navigation, stack.length, tab, landing, pendingLeave]);

  const register = useCallback((key: string, dirty: boolean) => { if (dirty) guards.current.set(key, true); else guards.current.delete(key); }, []);
  const top = stack.length - 1, split = wide && top > 0 && DETAIL_ROUTES.has(stack[top]!.name);

  const destinations = <View accessibilityRole="tablist" onLayout={event => setBarHeight(wide ? 0 : event.nativeEvent.layout.height)} style={wide
    ? { width: 96, backgroundColor: colors.surface, borderRightWidth: 1, borderRightColor: colors.border, paddingVertical: spacing.md, gap: spacing.xs }
    : { flexDirection: "row", backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border }}>
    {tabs.map(item => {
      const on = item === tab;
      return <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={t(TAB_LABEL[item])}
        onPress={() => on ? navigation.open(item) : setSelected(item)}
        style={{ flex: wide ? undefined : 1, minHeight: TOUCH_TARGET + 8, alignItems: "center", justifyContent: "center", paddingVertical: spacing.xs,
          borderTopWidth: wide ? 0 : 3, borderLeftWidth: wide ? 3 : 0, borderColor: on ? colors.primary : "transparent", backgroundColor: on ? colors.selected : "transparent" }}>
        <Text importantForAccessibility="no" style={{ fontSize: 18, color: on ? colors.selectedInk : colors.muted }}>{TAB_GLYPH[item]}</Text>
        <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: on ? "700" : "500", color: on ? colors.selectedInk : colors.muted }}>{t(TAB_LABEL[item])}</Text>
      </Pressable>;
    })}
  </View>;

  return <SafeAreaView edges={["top", "bottom", "left", "right"]} style={{ flex: 1, backgroundColor: colors.canvas }}>
    <NavigationContext.Provider value={navigation}><GuardContext.Provider value={register}><BelowScreenContext.Provider value={wide ? bottomInset : barHeight + bottomInset}>
      <View style={{ flex: 1, flexDirection: wide ? "row" : "column-reverse" }}>
        {destinations}
        <View style={{ flex: 1, flexDirection: "row" }}>
          {stack.map((item, index) => {
            const visible = index === top || (split && index === top - 1);
            const Screen = SCREENS[item.name];
            return <View key={item.key} style={visible ? { flex: split ? index === top ? 3 : 2 : 1, borderRightWidth: split && index === top - 1 ? 1 : 0, borderRightColor: colors.border } : { display: "none" }}
              importantForAccessibility={visible ? "auto" : "no-hide-descendants"}>
              <ActiveContext.Provider value={visible}><RouteContext.Provider value={item}><Screen /></RouteContext.Provider></ActiveContext.Provider>
            </View>;
          })}
        </View>
      </View>
      <Confirm visible={pendingLeave !== undefined} title={t("discardTitle")} text={t("discardText")} confirmLabel={t("discard")} destructive
        onCancel={() => setPendingLeave(undefined)} onConfirm={() => { const leave = pendingLeave; setPendingLeave(undefined); leave?.(); }} />
    </BelowScreenContext.Provider></GuardContext.Provider></NavigationContext.Provider>
  </SafeAreaView>;
}
