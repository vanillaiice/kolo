import { useRef } from "react";
import { Modal, Text, View } from "react-native";
import { CameraView } from "expo-camera";
import { useText } from "../app/i18n.tsx";
import { spacing, useTheme } from "./theme.ts";
import { Button, useStyles } from "./ui.tsx";

/**
 * Full-screen QR scanner. `accept` returns true for a code it understood; other QR codes are ignored so the camera keeps
 * looking. The caller asks for camera permission first.
 */
export function QrScanner({ visible, help, accept, onClose }: { readonly visible: boolean; readonly help: string; readonly accept: (data: string) => boolean; readonly onClose: () => void }): React.JSX.Element {
  const { t } = useText(), s = useStyles(), { colors } = useTheme(), done = useRef(false);
  return <Modal visible={visible} animationType="slide" onShow={() => { done.current = false; }} onRequestClose={onClose}>
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      {visible && <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => { if (!done.current && accept(data)) done.current = true; }} />}
      <View style={{ padding: spacing.lg, gap: spacing.md, backgroundColor: colors.surface }}>
        <Text style={s.body}>{help}</Text>
        <Button label={t("cancel")} variant="secondary" onPress={onClose} />
      </View>
    </View>
  </Modal>;
}
