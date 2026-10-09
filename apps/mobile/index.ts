/**
 * The device's entry point.
 *
 * Deliberately thin. Everything it does is register the root component; the
 * work of opening the database and deciding what to draw belongs in `App`,
 * where it can be read in one place.
 */

import { registerRootComponent } from "expo";
import { install } from "react-native-quick-crypto";

import App from "./src/app/App.tsx";

install();
registerRootComponent(App);
