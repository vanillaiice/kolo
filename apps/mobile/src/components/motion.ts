/**
 * The app's motion: short fades and slides that show where something came from, never a wait before work.
 * Layout animations and timings follow Android's "remove animations" setting (Reanimated's `ReduceMotion.System`);
 * colour transitions check it explicitly.
 */

import { Pressable } from "react-native";
import Animated, { FadeIn, FadeInDown, FadeInRight, FadeOut, FadeOutRight, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";

/** Milliseconds. A press answers within a frame or two; a screen settles in under a quarter second. */
export const DURATION = { press: 90, quick: 160, screen: 220 } as const;

/** Status text, errors and empty states fade in where they appear. */
export const appear = FadeIn.duration(DURATION.quick);
/** What leaves fades quickly, so the next thing is readable at once. */
export const disappear = FadeOut.duration(DURATION.press);
/** A pushed screen slides a little from the right, the direction Back returns to. */
export const pushIn = FadeInRight.duration(DURATION.screen);
/** A popped screen leaves the way it came. */
export const popOut = FadeOutRight.duration(DURATION.quick);
/** Dialogs rise slightly into place. */
export const rise = FadeInDown.duration(DURATION.quick);

/** Pressable that accepts animated styles. */
export const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * A pressed control shrinks and dims slightly. `rest` is the control's own opacity (for example 0.5 when disabled),
 * which the pressed state scales rather than replaces.
 */
export function usePressMotion(rest = 1): {
  readonly style: ReturnType<typeof useAnimatedStyle>; readonly onPressIn: () => void; readonly onPressOut: () => void;
} {
  const pressed = useSharedValue(0);
  const style = useAnimatedStyle(() => ({ opacity: rest * (1 - 0.12 * pressed.value), transform: [{ scale: 1 - 0.03 * pressed.value }] }));
  return { style, onPressIn: () => { pressed.value = withTiming(1, { duration: DURATION.press }); }, onPressOut: () => { pressed.value = withTiming(0, { duration: DURATION.quick }); } };
}

/** Selection colours (segments, tabs) change smoothly; instantly when the system asks for reduced motion. */
export function useColorTransition(): { readonly transitionProperty?: ("backgroundColor" | "borderColor")[]; readonly transitionDuration?: number } {
  return useReducedMotion() ? {} : { transitionProperty: ["backgroundColor", "borderColor"], transitionDuration: DURATION.quick };
}
