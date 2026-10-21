# KOLO changelog

What changed in each release, for the people who use KOLO. The release script copies a version's section into its
GitHub release, and installed desktop apps show it before updating, so write it for a shopkeeper, not a developer.

- Before tagging, rename `## Unreleased` to `## X.Y.Z` (the root `package.json` version). A release cannot be created
  or published without that section.
- Write `### Français` first, then `### English`; the app shows the reader's language.
- Say what someone will notice: new things they can do, fixes, and anything that works differently. Leave out
  internal changes. Do not use a `---` line inside a section: it ends the notes shown in the app.

## 0.10.0

### Français

- Un ordinateur peut rejoindre une boutique avec le code à 10 caractères du propriétaire et l’adresse affichée
  dessous, même si la caisse principale est un téléphone. Sur le téléphone, « Ajouter une caisse » peut envoyer le
  lien à l’ordinateur.
- Coller un code de partage du serveur au mauvais endroit affiche maintenant un message clair.

### English

- A computer can join a shop with the owner's 10-character code and the address shown under it, even when the main
  till is a phone. On the phone, Add a till can send the link to the computer.
- Pasting a server share code in the wrong place now shows a clear message.

## 0.9.0

### Français

- KOLO sur ordinateur vérifie s’il existe une nouvelle version et vous propose de l’installer, avec la liste des
  nouveautés. Dans Réglages → Mises à jour, vous pouvez installer automatiquement les corrections et les nouveautés
  compatibles ; une mise à jour importante attend toujours votre accord.
- Avant chaque installation, KOLO garde une copie de la boutique sur l’ordinateur.

### English

- Desktop KOLO checks for a new version and offers to install it, with a list of what is new. In Settings → Updates
  you can install fixes and compatible improvements automatically; a major update always waits for you.
- Before every install, KOLO keeps a copy of the shop on the computer.
