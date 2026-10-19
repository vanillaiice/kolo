# Démarrage rapide kolo

Du téléchargement à votre première vente en 15 minutes environ. *[English version](quick-start.en.md)*

kolo est en **bêta publique**. Tout ce qui suit fonctionne sans Internet.

## 1. Installer

Téléchargez kolo sur **[kolo.hblabs.xyz](https://kolo.hblabs.xyz/)**.

| Appareil | Fichier | Remarques |
| --- | --- | --- |
| Windows | Installateur (`…-win-x64-setup.exe`) | Windows peut avertir que l’application n’est pas signée : choisissez **Informations complémentaires → Exécuter quand même**. |
| Linux | AppImage ou `.deb` | Rendez l’AppImage exécutable (clic droit → Propriétés → *Autoriser l’exécution*), puis ouvrez-la. |
| Android | APK universel | Autorisez votre navigateur ou gestionnaire de fichiers à installer des applications, puis ouvrez le fichier. |

Pour mettre à jour, installez la nouvelle version par-dessus l’ancienne. Votre boutique est conservée.

## 2. Créer votre boutique

Sur un ordinateur :

1. Ouvrez kolo et choisissez la **Langue** (français ou anglais).
2. Choisissez **Commencer une boutique**.
3. **Votre boutique** : saisissez le **Nom de la boutique** et **Votre nom**. Les noms de la caisse et du compte espèces sont déjà prêts ; changez-les seulement si vous le souhaitez.
4. **Votre accès** : choisissez un **code de 6 à 8 chiffres** (ou un mot de passe de 12 caractères minimum), tapez-le deux fois, puis cliquez sur **Créer la boutique et ouvrir la caisse**.
5. kolo affiche votre **clé de récupération**. Notez-la ou copiez-la en lieu sûr, puis cliquez sur **J’ai conservé ma clé**.

> ⚠️ La clé de récupération est le seul moyen de remplacer un code propriétaire oublié. Gardez-la loin du comptoir.

Sur un téléphone Android, c’est pareil : touchez **Créer votre boutique**, remplissez les noms, puis choisissez votre code.

## 3. Ajouter vos premiers articles

Allez dans **Articles & stock → Ajouter un article** et remplissez :

- **Nom de l’article** et **Prix de vente · FCFA**
- **Coût unitaire · FCFA** : facultatif, mais les rapports en ont besoin pour afficher votre marge
- **Stock initial** : la quantité en rayon aujourd’hui
- **Code-barres** : facultatif. Vous pouvez le taper ou le scanner à la caisse avec une douchette.
- Cochez **Autoriser les quantités fractionnées** pour ce qui se vend au poids ou au volume (riz, huile…)

Cliquez sur **Enregistrer l’article**. Ajoutez deux ou trois autres articles.

## 4. Faire votre première vente

1. Ouvrez **Caisse**, recherchez un article (ou saisissez son code-barres) et cliquez dessus pour l’ajouter.
2. Changez la **Quantité** si besoin.
3. Choisissez comment le client paie :
   - **Payer maintenant** : saisissez les **Espèces reçues** pour voir la **Monnaie à rendre**, ou répartissez le montant sur plusieurs comptes.
   - **Vente à crédit** : choisissez d’abord un client. Ce qui n’est pas payé va sur son compte.
4. Cliquez sur **Terminer la vente**. kolo ouvre le reçu enregistré : cliquez sur **Imprimer le reçu** si vous avez une imprimante, puis sur **Nouvelle vente**.

Votre vente reste dans **Reçus**, le stock a baissé dans **Articles & stock**, et le total du jour apparaît dans **Rapports**.

> 💡 Vous acceptez Mobile Money ? Ajoutez un compte dans **Comptes & dépenses → Ajouter un compte** avec le type **Mobile Money**. Il apparaît alors à la caisse.

## 5. Enregistrer une sauvegarde

Allez dans **Sauvegarde & appareils → Sauvegarde chiffrée** :

1. Choisissez un **Mot de passe du fichier** (12 caractères minimum) et tapez-le deux fois.
2. Cliquez sur **Enregistrer une sauvegarde** et rangez le fichier `.kolo-backup` hors de cet ordinateur, par exemple sur une clé USB ou dans vos e-mails.

Dans le même écran, cliquez aussi sur **Créer une clé de récupération**. Notez ou imprimez les 14 groupes : ils ouvrent vos sauvegardes même si le mot de passe est oublié ou si toutes les caisses sont perdues. **Ils ne sont affichés qu’une seule fois.**

## 6. Facultatif : ajouter votre personnel et votre téléphone

**Personnel** : allez dans **Personnel → Ajouter un membre**, saisissez un nom, choisissez un **Rôle** (par exemple **Caissier**) et donnez-lui son propre code. Chacun se connecte avec son code, et le **Journal** montre qui a fait quoi.

**Un téléphone ou un deuxième ordinateur**, sur le même Wi-Fi ou point d’accès (sans Internet) :

1. Sur l’ordinateur principal : **Sauvegarde & appareils → Relier une nouvelle caisse → Afficher un code**.
2. Sur le téléphone : ouvrez kolo, touchez **Rejoindre une boutique** et scannez le code QR. Un deuxième ordinateur utilise **Rejoindre une boutique à proximité** et colle le lien copié.
3. Sur l’ordinateur principal, cliquez sur **Autoriser**.

Le code ne sert qu’une fois et expire au bout de 10 minutes. Gardez kolo ouvert et déverrouillé sur l’ordinateur principal pendant la synchronisation.

## Conseils du quotidien

- **Verrouillez** la caisse quand vous vous absentez. Sur un ordinateur partagé, désactivez **Paramètres → Rester connecté sur cet ordinateur**.
- **Code oublié ?** Sur l’écran de déverrouillage, cliquez sur **Code oublié ?** et saisissez la clé de récupération du propriétaire.
- **Le stock semble faux ?** Utilisez **Compter le stock**. kolo enregistre l’écart au lieu d’écraser le stock.
- **Une erreur dans une vente ?** Utilisez **Retour d’articles** sur le reçu. Les ventes ne sont jamais effacées, elles sont corrigées.

## Pour aller plus loin

Le guide détaillé (bientôt disponible) couvre les fournisseurs et achats, les dépenses et comptages de caisse, les plafonds de crédit et délais de paiement, la taxe, les rapports, les retours, les serveurs de synchronisation et la récupération complète.

---

Des questions ? Écrivez à [contact@hblabs.xyz](mailto:contact@hblabs.xyz).

kolo · conçu par hblabs · [kolo.hblabs.xyz](https://kolo.hblabs.xyz/)
