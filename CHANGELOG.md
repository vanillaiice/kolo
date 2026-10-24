# KOLO changelog

What changed in each release, for the people who use KOLO. The release script copies a version's section into its
GitHub release, and installed desktop apps show it before updating, so write it for a shopkeeper, not a developer.

- Before tagging, rename `## Unreleased` to `## X.Y.Z` (the root `package.json` version). A release cannot be created
  or published without that section.
- Write `### Français` first, then `### English`; the app shows the reader's language.
- Say what someone will notice: new things they can do, fixes, and anything that works differently. Leave out
  internal changes. Do not use a `---` line inside a section: it ends the notes shown in the app.

## 0.11.0

### Français

- Une caisse verrouillée dont on a oublié le code et la clé de récupération peut démarrer une nouvelle boutique.
  L’ancienne est mise de côté, jamais effacée, et peut être rouverte plus tard avec son propre code.
- Le propriétaire voit « En attente de votre accord » dans le journal : les opérations venues d’autres caisses et
  mises de côté (par exemple d’une caisse retirée, ou deux retours de la même vente faits en même temps) peuvent être
  vérifiées puis acceptées une par une.
- Retirer une caisse ne fait plus perdre les ventes qu’elle avait déjà envoyées : les autres caisses les reçoivent
  toujours.
- Changer le code ou les droits d’un employé ne bloque plus ses ventes encore en route vers les autres caisses.
- Avec un serveur, l’abonnement peut limiter le nombre de caisses ; l’écran de synchronisation indique combien sont
  autorisées et utilisées.
- Sur téléphone et ordinateur, chaque champ a maintenant une courte description, le clavier ne cache plus les champs
  et les écrans s’animent légèrement. Dans Plus, chaque entrée a une description.
- Important : mettez à jour toutes les caisses. Une caisse d’une version plus ancienne ne peut plus rejoindre une
  boutique avec le code à 10 caractères d’un propriétaire en 0.11.0, ni l’inverse.

### English

- A locked till whose code and recovery key are both forgotten can start a new shop. The old one is set aside,
  never erased, and can be reopened later with its own code.
- The owner sees "Waiting for your approval" in the journal: operations from other tills that were held back (for
  example from a removed till, or two returns of the same sale made at the same time) can be checked and accepted
  one by one.
- Removing a till no longer loses the sales it had already sent: the other tills still receive them.
- Changing a staff member's code or permissions no longer blocks their sales still on their way to other tills.
- With a server, the plan can limit how many tills a shop has; the sync screen shows how many are allowed and in
  use.
- On phone and computer, every field now has a short description, the keyboard no longer hides fields, and screens
  move a little. In More, every item has a description.
- Important: update every till. A till on an older version can no longer join a shop with the 10-character code of
  an owner on 0.11.0, or the other way round.

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
