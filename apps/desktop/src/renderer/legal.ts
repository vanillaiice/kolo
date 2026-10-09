import type { Language } from "./text.ts";

/** One titled section of a legal document; paragraphs are plain text. */
export interface LegalSection { readonly heading: string; readonly paragraphs: readonly string[] }
/** A legal document shown inside the app. */
export interface LegalDocument { readonly title: string; readonly sections: readonly LegalSection[] }
export type LegalKind = "terms" | "privacy" | "licenses";

/** Date the current terms and privacy notice took effect. */
export const LEGAL_EFFECTIVE_DATE = "2026-10-09";

/** Open-source components shipped in the desktop app, with their licences. */
export const OPEN_SOURCE: readonly { readonly name: string; readonly license: string }[] = [
  { name: "Electron", license: "MIT" },
  { name: "Chromium", license: "BSD-3-Clause" },
  { name: "Node.js", license: "MIT" },
  { name: "React · React DOM · Scheduler", license: "MIT" },
  { name: "Zod", license: "MIT" },
  { name: "Inter (font)", license: "OFL-1.1" },
];

const documents: Record<LegalKind, Record<Language, LegalDocument>> = {
  terms: {
    fr: { title: "Conditions d’utilisation", sections: [
      { heading: "1. Objet", paragraphs: ["Ces conditions s’appliquent à l’utilisation du logiciel de caisse KOLO (« KOLO »), fourni par hblabs. En créant ou en ouvrant une boutique dans KOLO, vous les acceptez. Si vous ne les acceptez pas, n’utilisez pas KOLO."] },
      { heading: "2. Licence", paragraphs: ["KOLO est un logiciel libre, distribué sous la licence publique générale GNU version 3 (GPL-3.0). Vous pouvez l’utiliser, l’étudier, le partager et le modifier selon cette licence. Si vous distribuez KOLO ou une version modifiée, vous devez le faire sous la même licence et fournir le code source correspondant. Le texte complet de la licence figure dans Logiciels open source.", "Les noms et logos « kolo » et « hblabs » ne sont pas couverts par cette licence. Une version modifiée ne doit pas se présenter comme KOLO ni comme une version fournie par hblabs. Les autres composants open source restent soumis à leurs propres licences."] },
      { heading: "3. Vos données et vos enregistrements", paragraphs: ["KOLO enregistre les données de votre boutique sur vos appareils. Vous êtes responsable de l’exactitude de ce que vous enregistrez, de la protection de vos codes et de votre clé de récupération, et de sauvegardes régulières. hblabs ne peut ni consulter, ni récupérer, ni restaurer vos données, vos codes ou votre clé de récupération."] },
      { heading: "4. Vos obligations légales", paragraphs: ["Vous restez responsable du respect des lois applicables à votre activité, notamment en matière fiscale, de facturation, de comptabilité, de protection des consommateurs et des données personnelles.", "Sauf indication écrite de hblabs, KOLO n’est pas un dispositif fiscal certifié ni une caisse enregistreuse agréée. Ses reçus et rapports ne remplacent pas les documents exigés par la loi."] },
      { heading: "5. Ordinateurs partagés", paragraphs: ["Si « Rester connecté » est activé, toute personne ayant accès à l’ordinateur peut ouvrir la caisse. Désactivez cette option sur un ordinateur partagé et verrouillez la caisse lorsque vous vous absentez."] },
      { heading: "6. Absence de garantie", paragraphs: ["KOLO est fourni « en l’état », sans garantie d’aucune sorte, dans la mesure permise par la loi. hblabs ne garantit pas que KOLO sera exempt d’erreurs ou d’interruptions."] },
      { heading: "7. Limitation de responsabilité", paragraphs: ["Dans la mesure permise par la loi, hblabs n’est pas responsable des pertes indirectes, notamment perte de bénéfices, perte de données ou interruption d’activité, liées à l’utilisation ou à l’impossibilité d’utiliser KOLO. Rien dans ces conditions ne limite une responsabilité qui ne peut l’être légalement."] },
      { heading: "8. Mises à jour", paragraphs: ["hblabs peut mettre à jour KOLO et ces conditions. Les nouvelles conditions s’appliquent à partir de la version qui les contient ; la date ci-dessus indique la version en vigueur."] },
      { heading: "9. Contact", paragraphs: ["Pour toute question sur ces conditions, contactez hblabs par le canal grâce auquel vous avez obtenu KOLO."] },
    ] },
    en: { title: "Terms of use", sections: [
      { heading: "1. About these terms", paragraphs: ["These terms apply to your use of the KOLO till software (“KOLO”), provided by hblabs. By creating or opening a shop in KOLO, you accept them. If you do not accept them, do not use KOLO."] },
      { heading: "2. Licence", paragraphs: ["KOLO is free software, released under the GNU General Public License version 3 (GPL-3.0). You may use, study, share and modify it under that licence. If you distribute KOLO or a modified version, you must do so under the same licence and provide the corresponding source code. The full licence text is in Open-source software.", "The “kolo” and “hblabs” names and logos are not covered by this licence. A modified version must not present itself as KOLO or as provided by hblabs. Other open-source components remain under their own licences."] },
      { heading: "3. Your data and records", paragraphs: ["KOLO stores your shop’s data on your devices. You are responsible for the accuracy of what you record, for keeping your codes and recovery key safe, and for making regular backups. hblabs cannot see, recover or restore your data, codes or recovery key."] },
      { heading: "4. Your legal obligations", paragraphs: ["You remain responsible for complying with the laws that apply to your business, including tax, invoicing, accounting, consumer protection and personal data rules.", "Unless hblabs states otherwise in writing, KOLO is not a certified fiscal device or an approved cash register. Its receipts and reports do not replace documents required by law."] },
      { heading: "5. Shared computers", paragraphs: ["If “Stay signed in” is on, anyone who can use the computer can open the till. Turn it off on shared computers and lock the till when you step away."] },
      { heading: "6. No warranty", paragraphs: ["KOLO is provided “as is”, without warranty of any kind, to the extent permitted by law. hblabs does not guarantee that KOLO will be free of errors or interruptions."] },
      { heading: "7. Limitation of liability", paragraphs: ["To the extent permitted by law, hblabs is not liable for indirect losses, including lost profits, lost data or business interruption, arising from the use of or inability to use KOLO. Nothing in these terms limits liability that cannot be limited by law."] },
      { heading: "8. Updates", paragraphs: ["hblabs may update KOLO and these terms. New terms apply from the version that contains them; the date above shows the version in force."] },
      { heading: "9. Contact", paragraphs: ["For questions about these terms, contact hblabs through the channel from which you obtained KOLO."] },
    ] },
  },
  privacy: {
    fr: { title: "Confidentialité", sections: [
      { heading: "En bref", paragraphs: ["KOLO fonctionne sans connexion. L’application de bureau n’envoie ni les données de votre boutique, ni celles de vos clients, ni statistiques d’utilisation à hblabs ou à qui que ce soit."] },
      { heading: "Ce que KOLO enregistre", paragraphs: ["Sur cet ordinateur : les informations de la boutique, les articles et le stock, les ventes et reçus, les clients (nom, téléphone, adresse, notes, solde), les fournisseurs et achats, les comptes et dépenses, le nom et le rôle du personnel, et un journal d’activité.", "Les codes et clés sont conservés dans le stockage protégé du système d’exploitation, jamais en texte lisible."] },
      { heading: "Les fichiers que vous créez", paragraphs: ["Les sauvegardes, invitations et fichiers d’échange sont enregistrés uniquement là où vous le choisissez, chiffrés avec le mot de passe que vous définissez. Toute personne disposant du fichier et de son mot de passe peut le lire : protégez les deux."] },
      { heading: "Les données de vos clients et de votre personnel", paragraphs: ["Vous décidez quelles données enregistrer et pourquoi. Vous en êtes responsable selon la loi sur la protection des données qui s’applique à vous, notamment pour informer les personnes concernées et répondre à leurs demandes d’accès, de rectification ou de suppression."] },
      { heading: "hblabs", paragraphs: ["Vos données restant sur vos appareils, hblabs ne les collecte ni ne les traite. Si vous contactez hblabs pour obtenir de l’aide, ne partagez que les fichiers ou captures nécessaires."] },
      { heading: "Supprimer les données", paragraphs: ["La désinstallation de KOLO conserve les données de la boutique afin de pouvoir la réinstaller. Pour supprimer définitivement une boutique, supprimez le dossier de données de KOLO dans les données d’application de votre compte utilisateur, après avoir conservé toute sauvegarde dont vous avez besoin."] },
    ] },
    en: { title: "Privacy notice", sections: [
      { heading: "In short", paragraphs: ["KOLO works offline. The desktop app does not send your shop’s data, your customers’ data or usage statistics to hblabs or anyone else."] },
      { heading: "What KOLO stores", paragraphs: ["On this computer: shop details, products and stock, sales and receipts, customers (name, phone, address, notes, balance), suppliers and purchases, accounts and expenses, staff names and roles, and an activity log.", "Codes and keys are kept in the operating system’s protected storage, never as readable text."] },
      { heading: "Files you create", paragraphs: ["Backups, invitations and exchange files are saved only where you choose, encrypted with the password you set. Anyone with the file and its password can read it, so keep both safe."] },
      { heading: "Your customers’ and staff data", paragraphs: ["You decide what data to record and why. You are responsible for it under the data protection law that applies to you, including telling people about it and answering their requests to see, correct or delete it."] },
      { heading: "hblabs", paragraphs: ["Because your data stays on your devices, hblabs does not collect or process it. If you contact hblabs for help, share only the files or screenshots that are needed."] },
      { heading: "Deleting data", paragraphs: ["Uninstalling KOLO keeps the shop’s data so it can be reinstalled. To delete a shop permanently, delete KOLO’s data folder in your user account’s application data, after keeping any backup you need."] },
    ] },
  },
  licenses: {
    fr: { title: "Logiciels open source", sections: [
      { heading: "Composants", paragraphs: ["KOLO est un logiciel libre sous licence GPL-3.0 (texte complet ci-dessous). Il inclut les logiciels open source ci-dessous, utilisés selon leurs licences. Les textes complets (LICENSE.electron.txt et LICENSES.chromium.html) sont installés avec KOLO."] },
    ] },
    en: { title: "Open-source software", sections: [
      { heading: "Components", paragraphs: ["KOLO is free software under the GPL-3.0 (full text below). It includes the open-source software below, used under their licences. The full texts (LICENSE.electron.txt and LICENSES.chromium.html) are installed alongside KOLO."] },
    ] },
  },
};

/** Returns a legal document in the selected language. */
export function legalDocument(kind: LegalKind, language: Language): LegalDocument { return documents[kind][language]; }
