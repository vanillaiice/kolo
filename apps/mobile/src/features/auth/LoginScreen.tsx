/**
 * Logging a device in (ADR-012).
 *
 * The one screen in the app that needs the network, and the only one. PIN
 * hashes never leave the server, so a device that has never spoken to it has
 * nothing to check a PIN against — a gap ADR-012 states plainly rather than
 * works around. Everything after this runs offline for as long as the session
 * lasts.
 *
 * It does no validation of its own: what counts as a fillable-in form is in
 * `domain/auth/login-form.ts`, tested under Node, and the problems come back as
 * codes that this file turns into French (§44). A second set of rules here is
 * how a screen comes to refuse what the server would have accepted.
 */

import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors, spacing, TOUCH_TARGET, type as typography } from "../../components/theme.ts";
import type { Database } from "@kolo/core/data/database/driver";
import { logIn, LoginError, type AuthTransport } from "@kolo/core/data/auth/login";
import type { SecretStore } from "@kolo/core/data/auth/secure-store";
import { EnrolmentError, type Session } from "@kolo/core/data/auth/session";
import {
  canSubmit,
  emptyLoginForm,
  viewLoginForm,
  type LoginFormState,
  type LoginProblem,
} from "@kolo/core/domain/auth/login-form";

/** What the person filling the form is told, in French (§44). */
const PROBLEM_TEXT: Record<LoginProblem, string> = {
  BUSINESS_REQUIRED: "Entrez le code de la boutique",
  BUSINESS_MALFORMED: "Ce code de boutique n'est pas valide",
  PHONE_REQUIRED: "Entrez votre numéro de téléphone",
  PHONE_MALFORMED: "Ce numéro n'est pas valide",
  PIN_REQUIRED: "Entrez votre code",
  PIN_LENGTH: "Le code fait de 4 à 8 chiffres",
  PIN_NOT_DIGITS: "Le code ne contient que des chiffres",
};

/**
 * What the server's refusals mean to the person at the till.
 *
 * Each says what to do next, because "invalid_credentials" is not something a
 * cashier can act on. A wrong number and a wrong PIN read the same, which is
 * the server's rule and not a detail this screen may soften: telling someone
 * their number is registered would make login a way to discover who works here.
 */
function refusalText(error: LoginError): string {
  switch (error.code) {
    case "invalid_credentials":
      return "Numéro ou code incorrect";
    case "account_suspended":
      return "Ce compte est suspendu. Voyez le propriétaire de la boutique.";
    case "device_suspended":
      return "Cet appareil n'est plus en service. Voyez le propriétaire.";
    case "business_suspended":
      return "Cette boutique n'est plus en service.";
    case "too_many_attempts":
      return error.retryAfterSeconds === undefined
        ? "Trop de tentatives. Patientez avant de réessayer."
        : `Trop de tentatives. Réessayez dans ${Math.ceil(error.retryAfterSeconds)} s.`;
    case "unreachable":
      // §45 treats this as ordinary rather than exceptional: a shop out of
      // coverage is Tuesday, not a fault.
      return "Serveur injoignable. Connectez-vous là où il y a du réseau.";
    case "invalid_request":
    case "server_error":
      return "Le serveur n'a pas accepté la connexion. Réessayez plus tard.";
  }
}

/** What this installation calls itself when the server registers it (§28). */
const DEVICE_PLATFORM = Platform.OS === "android" ? "ANDROID" : Platform.OS === "ios" ? "IOS" : "DESKTOP";

export function LoginScreen({
  database,
  secrets,
  transport,
  onEnrolled,
}: {
  readonly database: Database;
  readonly secrets: SecretStore;
  readonly transport: AuthTransport;
  /** Called with the session once the device is enrolled. */
  readonly onEnrolled: (session: Session) => void;
}): React.JSX.Element {
  const [form, setForm] = useState<LoginFormState>(emptyLoginForm);
  const [label, setLabel] = useState("Caisse 1");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  /** Problems are hidden until the first attempt: nobody wants to be told
   * their PIN is too short while they are still typing it. */
  const [attempted, setAttempted] = useState(false);

  const view = useMemo(() => viewLoginForm(form), [form]);
  const ready = canSubmit(view);

  const change = useCallback((field: keyof LoginFormState, value: string) => {
    setFailure(undefined);
    setForm((current) => ({ ...current, [field]: value }));
  }, []);

  const submit = useCallback(() => {
    setAttempted(true);
    if (!ready || busy || view.businessId === undefined) {
      return;
    }

    setBusy(true);
    setFailure(undefined);
    void (async () => {
      try {
        const session = await logIn(database, secrets, transport, {
          businessId: view.businessId ?? "",
          phone: view.phone,
          pin: form.pin,
          device: { label: label.trim() === "" ? "Caisse" : label.trim(), platform: DEVICE_PLATFORM },
        });
        onEnrolled(session);
      } catch (error) {
        if (error instanceof LoginError) {
          setFailure(refusalText(error));
        } else if (error instanceof EnrolmentError) {
          setFailure(
            error.code === "another_business"
              ? "Cet appareil est déjà rattaché à une autre boutique."
              : "Cette boutique n'utilise pas le franc CFA.",
          );
        } else {
          // Anything else is this device's problem — a keystore that refused,
          // a database that would not write. Shown rather than swallowed: a
          // login button that does nothing is the worst of the outcomes.
          setFailure(error instanceof Error ? error.message : String(error));
        }
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, database, form.pin, label, onEnrolled, ready, secrets, transport, view]);

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Connexion</Text>
        <Text style={styles.blurb}>
          La première connexion a besoin du réseau. Ensuite, la caisse fonctionne hors ligne.
        </Text>

        <Field
          label="Code de la boutique"
          value={form.business}
          onChangeText={(value) => change("business", value)}
          placeholder="0190f3a1-4c2b-…"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Field
          label="Téléphone"
          value={form.phone}
          onChangeText={(value) => change("phone", value)}
          placeholder="6 77 12 34 56"
          keyboardType="phone-pad"
        />
        <Field
          label="Code secret"
          value={form.pin}
          onChangeText={(value) => change("pin", value)}
          placeholder="••••"
          keyboardType="number-pad"
          secureTextEntry
          onSubmitEditing={submit}
        />
        <Field
          label="Nom de cet appareil"
          value={label}
          onChangeText={setLabel}
          placeholder="Caisse 1"
          autoCorrect={false}
        />

        {attempted && view.problems.length > 0 ? (
          <Text style={styles.problem}>{PROBLEM_TEXT[view.problems[0] ?? "PIN_REQUIRED"]}</Text>
        ) : null}
        {failure !== undefined ? <Text style={styles.problem}>{failure}</Text> : null}

        <Pressable
          style={[styles.submit, busy && styles.disabled]}
          disabled={busy}
          onPress={submit}
        >
          {busy ? (
            <ActivityIndicator color={colors.accentText} />
          ) : (
            <Text style={styles.submitText}>Se connecter</Text>
          )}
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function Field({
  label,
  ...input
}: React.ComponentProps<typeof TextInput> & { readonly label: string }): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput style={styles.input} placeholderTextColor={colors.muted} {...input} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md },
  title: { ...typography.title, color: colors.text },
  blurb: { ...typography.body, color: colors.muted, marginBottom: spacing.sm },
  field: { gap: spacing.xs },
  label: { ...typography.label, color: colors.muted },
  input: {
    minHeight: TOUCH_TARGET,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: spacing.sm,
    paddingHorizontal: spacing.md,
    ...typography.body,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  problem: { ...typography.body, color: colors.warning },
  submit: {
    minHeight: TOUCH_TARGET,
    borderRadius: spacing.sm,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.sm,
  },
  submitText: { ...typography.label, color: colors.accentText, fontSize: 16 },
  disabled: { opacity: 0.4 },
});
