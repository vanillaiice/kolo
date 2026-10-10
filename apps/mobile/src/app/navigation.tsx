import { createContext, useContext, useEffect, useRef } from "react";

export { TABS, type Tab, type RouteMap, type RouteName, type Route } from "./navigation-types.ts";
import type { RouteMap, RouteName, Route, Tab } from "./navigation-types.ts";

/** Stack operations for the current destination. */
export interface Navigation {
  readonly tab: Tab;
  push<K extends RouteName>(name: K, ...params: RouteMap[K] extends undefined ? [] : [RouteMap[K]]): void;
  replace<K extends RouteName>(name: K, ...params: RouteMap[K] extends undefined ? [] : [RouteMap[K]]): void;
  /** Leaves the current screen through the same rules as Android Back (including discard confirmation). */
  back(): void;
  /** Leaves the current screen after its work is saved, without the discard check. */
  leave(): void;
  /** Pops to the root of a destination, switching to it. */
  open(tab: Tab): void;
  /** Pops back until `name` is on top (or to the root). */
  popTo(name: RouteName): void;
}
export const NavigationContext = createContext<Navigation | undefined>(undefined);
/** The current destination's stack operations. */
export function useNav(): Navigation {
  const navigation = useContext(NavigationContext);
  if (navigation === undefined) throw new Error("useNav outside the shop shell");
  return navigation;
}

/** The route rendered by the current screen. */
export const RouteContext = createContext<Route | undefined>(undefined);
/** Parameters of the current screen. */
export function useParams<K extends RouteName>(_name: K): RouteMap[K] {
  const route = useContext(RouteContext);
  if (route === undefined || route.name !== _name) throw new Error(`useParams(${_name}) outside its route`);
  return route.params as RouteMap[K];
}

/** Registers a leave guard: while `dirty`, Back asks before discarding the screen's edits. */
export const GuardContext = createContext<(key: string, dirty: boolean) => void>(() => undefined);
/** Asks before discarding a meaningful edited draft when this screen is left by Back. */
export function useLeaveGuard(dirty: boolean): void {
  const register = useContext(GuardContext), route = useContext(RouteContext), key = route?.key;
  const last = useRef<boolean | undefined>(undefined);
  useEffect(() => { if (key !== undefined && last.current !== dirty) { last.current = dirty; register(key, dirty); } }, [key, dirty, register]);
  useEffect(() => () => { if (key !== undefined) register(key, false); }, [key, register]);
}
