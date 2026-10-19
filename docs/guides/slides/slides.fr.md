---
theme: default
title: kolo — Votre boutique, sans souci
info: |
  Courte présentation de kolo pour les visites de boutique et les formations.
  Les notes de l’orateur (touche P, mode présentateur) contiennent le texte du formateur.
colorSchema: light
transition: slide-left
mdc: true
---

<div class="cover">
  <img src="/kolo-icon.svg" class="logo" alt="Logo kolo" />
  <h1>Votre boutique.<br>Votre journée.<br>Sous contrôle.</h1>
  <p class="lead">Ventes, stock et crédit client. Votre boutique continue de tourner, même sans Internet.</p>
  <p class="tag">Bêta publique · Windows · Linux · Android · Français & anglais</p>
</div>

<!--
Présentez-vous. Une phrase : kolo est une caisse et un outil de gestion pour les boutiques du quotidien,
pensé pour la réalité d’ici : espèces, Mobile Money, crédit et Internet instable.
-->

---
layout: two-cols
---

# Le problème de tous les jours

- Les ventes notées dans un cahier, ou pas du tout
- Le crédit client oublié ou contesté
- Personne ne sait ce qu’il reste vraiment en rayon
- Le bénéfice est deviné en fin de mois
- Internet va et vient

::right::

<div class="callout">
  <p class="big">kolo remplace le cahier.</p>
  <p>Chaque vente, livraison et paiement est saisi une fois, au comptoir, et les totaux suivent tout seuls.</p>
</div>

<!--
Demandez au public : « Comment savez-vous aujourd’hui ce que chaque client vous doit ? »
Laissez répondre. La plupart diront le cahier ou la mémoire. C’est l’accroche.
-->

---

# Trois choses que fait kolo

<div class="pillars">
  <div><h3>Vendre</h3><p>Trouvez un article, encaissez, imprimez le reçu. Remises, paiements multiples et crédit.</p></div>
  <div><h3>Stock</h3><p>Livraisons, pertes et comptages. Des alertes avant la rupture.</p></div>
  <div><h3>Argent</h3><p>Ce que les clients vous doivent, ce que vous devez aux fournisseurs, les dépenses et les rapports.</p></div>
</div>

<img src="/screens/desktop-till.png" class="shot" alt="La caisse avec une vente en cours" />

<!--
Trois mots : Vendre, Stock, Argent. Tout le reste de la présentation est un détail de l’un des trois.
-->

---

# Fonctionne sans Internet

- Chaque vente et mouvement de stock est **enregistré d’abord sur l’appareil**
- Vente, stock, crédit et rapports n’attendent jamais la connexion
- Téléphone et ordinateur se synchronisent sur le **même Wi-Fi ou point d’accès**, sans Internet
- Un serveur de synchronisation, facultatif, relie des caisses éloignées

<div class="note">La connexion est un plus, pas une obligation.</div>

<!--
C’est la grande différence avec les caisses « dans le cloud ». Une coupure de courant ou un forfait
épuisé n’arrête pas le comptoir. La synchronisation rattrape son retard toute seule.
-->

---
layout: two-cols
---

# Vendre à la caisse

1. Recherchez un article ou tapez son code-barres
2. Ajoutez un client si besoin
3. **Payer maintenant** : espèces, Mobile Money, banque ou carte, en plusieurs fois si besoin
4. Ou **Vente à crédit** : le reste va sur le compte du client
5. **Terminer la vente** et imprimer le reçu

La monnaie à rendre est calculée pour vous.

::right::

<img src="/screens/mobile-sell-cart.png" class="phone" alt="Vendre sur Android" />

<!--
Faites une démonstration si possible : deux articles, un client, une partie en espèces, une partie en Mobile Money.
Montrez que le reçu se retrouve plus tard dans « Reçus ».
-->

---
layout: two-cols
---

# Articles & stock

- Nom, prix, coût et **stock initial** dans un seul formulaire
- **Ajouter du stock**, **Perte ou casse**, **Compter le stock**
- Chaque changement est gardé dans l’historique du stock
- **Seuil d’alerte de stock** par article
- Vente à l’unité ou en quantités fractionnées (kg, litres)

::right::

<img src="/screens/desktop-products.png" class="shot" alt="Liste des articles et du stock" />

<!--
Insistez : le stock n’est jamais écrasé. Un comptage enregistre l’écart : on voit ce qui
a disparu, et quand.
-->

---

# Clients & crédit

- Chaque client montre ce qu’il **doit** ou ce qu’il a **en avance**
- **Plafond de crédit** par client : le caissier ne peut pas le dépasser
- **Délais de paiement** et alertes en cas de retard
- Un **relevé** clair : ventes, paiements et solde après chaque opération
- La monnaie peut être gardée en avance pour le client

<div class="note">Fini les disputes sur le cahier : le relevé montre chaque opération.</div>

<!--
Pour les boutiques qui vendent à crédit, c’est cette diapositive qui convainc. Montrez un relevé client si vous avez des données de démonstration.
-->

---
layout: two-cols
---

# Argent & rapports

- Comptes : **Espèces**, **Mobile Money**, **Banque**, **Carte**
- Dépenses : loyer, électricité, transport, salaires…
- Comptez la caisse et voyez l’écart
- Rapports : ventes, marge, meilleures ventes, valeur du stock, dettes, taxe (TVA), à imprimer ou enregistrer en PDF
- Analyses : tendances et heures d’affluence

::right::

<img src="/screens/desktop-analytics.png" class="shot" alt="Analyses : chiffre d’affaires, marge et ventes dans le temps" />

<!--
Demandez : « Connaissez-vous votre bénéfice de la semaine dernière ? » La plupart non. kolo répond
en deux clics si les coûts des articles sont saisis.
-->

---

# Le personnel, chacun avec son code

| Rôle | Usage habituel |
| --- | --- |
| Propriétaire | Tout, y compris le personnel et les appareils |
| Responsable | Gère la boutique au quotidien |
| Caissier | Vend et encaisse |
| Gestionnaire de stock | Livraisons et comptages |
| Comptable | Argent et rapports |

Le propriétaire décide ce que chaque rôle peut faire, et peut faire des exceptions pour une personne. Le **Journal** montre qui a fait quoi, quand et sur quel appareil.

<!--
Les propriétaires craignent le vol. Les codes personnels et le journal répondent à cette inquiétude.
-->

---

# Téléphone et ordinateur ensemble

1. Sur l’ordinateur principal : **Sauvegarde & appareils → Relier une nouvelle caisse → Afficher un code**
2. Sur le téléphone : **Rejoindre une boutique** et scanner le code QR
3. Le propriétaire clique sur **Autoriser**

- Même Wi-Fi ou point d’accès : pas besoin d’Internet
- Ou par un serveur de synchronisation, depuis n’importe où
- Les données sont **chiffrées** sur la caisse avant l’envoi. Le serveur ne peut lire ni les ventes, ni les prix, ni les clients.

<!--
Le code ne sert qu’une fois et expire au bout de 10 minutes. Pour la synchronisation locale, kolo
doit rester ouvert et déverrouillé sur l’ordinateur principal.
-->

---

# Vos données restent à vous

- Les données sont sur **vos** appareils, pas dans le cloud de quelqu’un d’autre
- **Sauvegardes chiffrées**, protégées par un mot de passe
- **Clé de récupération du propriétaire** : remplace un code oublié
- **Clé de récupération des sauvegardes** (14 groupes, affichée une seule fois) : ouvre vos sauvegardes même si toutes les caisses sont perdues
- Open source : applications GPL-3.0, serveur de synchronisation AGPL-3.0

<div class="note">Gardez une sauvegarde et les feuilles de clés loin de la boutique.</div>

<!--
Soyez honnête : si le propriétaire perd à la fois son code et sa clé de récupération, sans sauvegarde,
personne ne peut retrouver les données. C’est le prix d’une vraie confidentialité.
-->

---

# Pratique : les 10 premières minutes

1. Installez kolo et choisissez votre langue
2. **Commencer une boutique** : nom de la boutique, votre nom, votre code
3. Conservez la **clé de récupération**
4. **Ajouter un article** ×3, avec un stock initial
5. Faites une vente, puis retrouvez-la dans **Reçus**
6. **Enregistrer une sauvegarde**

<div class="note">Suivez le guide de démarrage rapide.</div>

<!--
Formation seulement : distribuez le guide de démarrage (docs/guides/quick-start.fr.md) et laissez chaque
participant faire ces étapes sur son appareil. Passez dans la salle.
-->

---

# Où en est kolo aujourd’hui

- **Bêta publique** : Windows, Linux et Android
- Applications gratuites et open source ; héberger soi-même le serveur de synchronisation est gratuit
- Service de synchronisation hébergé : abonnement payant, contact@hblabs.xyz
- Plus tard : scan des codes-barres par la caméra, Google Play, F-Droid et iOS

<!--
Ne promettez pas de dates. Dites que les retours des vraies boutiques décident de la suite.
-->

---
layout: center
class: text-center
---

<img src="/kolo-icon.svg" class="logo-small" alt="Logo kolo" />

# Essayez kolo dès aujourd’hui

<p class="lead">kolo.hblabs.xyz · contact@hblabs.xyz</p>

Téléchargez · Essayez au comptoir · Posez-nous vos questions

<p class="credit">kolo · conçu par hblabs</p>

<!--
Laissez cette diapositive pendant les questions. Notez les contacts des boutiques qui veulent de l’aide pour démarrer.
-->
