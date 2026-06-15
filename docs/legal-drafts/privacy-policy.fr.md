---
title: "Njangi On-Chain — Politique de Confidentialité"
version: 1.0.0
effective_date: "{{EFFECTIVE_DATE}}"
language: fr
---

> **DRAFT — requires review by qualified counsel before publication.**
> **PROJET — doit être revu par un conseil juridique qualifié avant publication.**
> Le présent document est un projet professionnel destiné à une revue interne. Il ne constitue pas un avis juridique.
> Champs à compléter avant publication : `{{EFFECTIVE_DATE}}`, `{{PRIVACY_CONTACT}}`,
> `{{COMPANY_LEGAL_NAME}}`, `{{COMPANY_ADDRESS}}`.

# Politique de Confidentialité

**Version 1.0.0 — Date d'entrée en vigueur : {{EFFECTIVE_DATE}}**

La présente Politique de Confidentialité décrit la manière dont {{COMPANY_LEGAL_NAME}}, {{COMPANY_ADDRESS}} (« Njangi On-Chain », « nous ») traite vos données à caractère personnel lorsque vous utilisez Njangi On-Chain (le « Service »). Le Service est conçu pour réduire les données personnelles au strict minimum : nous ne détenons aucune clé privée, nous ne voyons jamais vos données de carte bancaire, et les seules données d'acheminement identifiantes que nous conservons hors de votre appareil sont chiffrées de sorte que nous puissions en détruire l'accès sur demande.

**Responsable du traitement :** {{COMPANY_LEGAL_NAME}}. **Contact confidentialité :** {{PRIVACY_CONTACT}}.

## 1. Données que nous traitons

| Catégorie | Exemples | Source | Localisation |
|---|---|---|---|
| **Identité OAuth** | Identifiant de sujet du fournisseur (`sub`), identifiant du client OAuth (`aud`), nom du fournisseur ; nom d'affichage et photo de profil affichés dans l'application | Connexion Google, Facebook ou Apple (zkLogin) | Notre base de données (enregistrements de sel cryptographique indexés par `sub`/`aud`) ; données de session |
| **Adresse électronique** | Courriel issu de votre profil OAuth ; courriel saisi dans le formulaire de liste d'attente | Vous / votre fournisseur OAuth | Notre base de données |
| **Données de portefeuille** | Votre adresse Sui (dérivée de votre identité OAuth et d'un sel cryptographique conservé côté serveur) ; sel chiffré ; codes de récupération hachés | Générées par le Service | Sel et empreintes de récupération dans notre base de données ; **l'adresse elle-même est publique sur la blockchain Sui** |
| **Données d'acheminement WhatsApp** | Numéro de téléphone (E.164) ou identifiant/nom de groupe WhatsApp utilisés pour les notifications du cercle | Vous / l'administrateur de votre cercle | Chiffrées (AES-256-GCM) et stockées sur le réseau de stockage décentralisé Walrus ; une empreinte HMAC (hachage à sens unique avec clé) du numéro dans notre base de données à des fins de recherche ; seuls un pointeur opaque et un nonce aléatoire figurent sur la chaîne — **jamais le numéro en clair** |
| **Activité sur la chaîne** | Appartenance aux cercles, cotisations, paiements, actions de récupération, empreintes de conformité opaques — rattachées à votre adresse Sui | Vos transactions | **La blockchain publique Sui (permanente)** |
| **Données de facturation** | Identifiant client Stripe, formule et statut d'abonnement, dates de période de facturation | Stripe | Notre base de données (statut uniquement) ; les données de paiement complètes sont détenues par **Stripe**, jamais par nous |
| **Données d'utilisation et techniques** | Adresse IP, données d'appareil/navigateur, journaux applicatifs, rapports d'erreur, demandes d'adhésion, préférences d'interface | Votre utilisation du Service | Nos serveurs/notre base de données |
| **Registres d'acceptation des documents juridiques** | Versions de documents acceptées, date, langue, et empreinte hachée de l'adresse IP | Votre acceptation dans l'application | Notre base de données |

Nous ne collectons **pas** de documents d'identité officiels, de numéros de carte ni de coordonnées bancaires. La vérification d'identité (KYC) pour les achats en monnaie fiduciaire est effectuée par les partenaires d'achat sur leurs propres plateformes (article 5).

## 2. Finalités du traitement

Nous traitons les données personnelles pour :

- créer et authentifier votre compte et dériver l'adresse de votre portefeuille (identité OAuth, sel) ;
- faire fonctionner les cercles d'épargne et afficher l'état pertinent à vous et à votre cercle ;
- envoyer les notifications WhatsApp configurées par vous ou par l'administrateur de votre cercle (par exemple « c'est votre tour de percevoir ») ;
- gérer les abonnements Gratuit/Premium et la facturation via Stripe ;
- sécuriser le Service, prévenir la fraude et les abus, et corriger les erreurs ;
- respecter nos obligations légales et répondre aux demandes licites des autorités ;
- consigner votre acceptation des documents juridiques ;
- avec votre consentement, vous informer des lancements (liste d'attente).

Nous ne vendons pas de données personnelles et ne les utilisons pas à des fins de publicité pour des tiers.

## 3. Comment l'architecture vous protège

- **Portefeuilles non dépositaires.** Votre portefeuille est dérivé via zkLogin ; nous ne détenons jamais vos clés privées et ne pouvons pas effectuer de transactions à votre place.
- **Données WhatsApp chiffrées.** Les numéros de téléphone et identifiants de groupes WhatsApp sont chiffrés en AES-256-GCM avant de quitter notre environnement serveur et stockés sur le réseau décentralisé Walrus. La blockchain ne contient qu'un pointeur opaque et un nonce aléatoire. Les recherches par numéro utilisent une empreinte à sens unique avec clé (HMAC), et non le numéro lui-même.
- **Données de chaîne pseudonymes.** La blockchain enregistre votre adresse Sui et vos transactions, pas votre nom. Sachez toutefois que l'analyse de blockchain peut parfois relier une adresse à une personne — voir l'article 7.
- **Ancrages de conformité opaques.** Lorsqu'un partenaire confirme ses contrôles KYC, seule une empreinte cryptographique peut être ancrée sur la chaîne. Cette empreinte ne contient ni nom, ni numéro de téléphone, ni donnée de document, ni pays.

## 4. Sous-traitants et destinataires

Nous partageons des données personnelles avec les catégories de destinataires suivantes, uniquement dans la mesure nécessaire :

| Destinataire | Rôle | Données concernées |
|---|---|---|
| **Google / Apple / Facebook (Meta)** | Fournisseurs de connexion OAuth | Flux d'authentification ; ils savent que vous vous êtes connecté au Service |
| **Stripe** | Prestataire de paiement des abonnements | Votre courriel et vos données de facturation (collectés directement par Stripe) ; nous recevons des identifiants client/abonnement et un statut, jamais les données de carte complètes |
| **Meta — Plateforme WhatsApp Business** | Acheminement des notifications WhatsApp | Numéro/groupe destinataire et contenu du message au moment de l'envoi, selon les conditions de Meta |
| **Walrus (réseau de stockage décentralisé)** | Stockage des enveloppes de données chiffrées | Texte chiffré uniquement ; les opérateurs de nœuds ne peuvent pas le lire |
| **Partenaires d'achat (Coinbase, MoonPay, Transak)** | Achats fiat-crypto, KYC/LBC | Si vous les utilisez, ils collectent vos données d'identité **en qualité de responsables de traitement indépendants**, selon leurs propres politiques ; nous recevons le statut de la transaction et l'adresse de destination |
| **Hébergeurs cloud et fournisseurs de bases de données** | Infrastructure | Données de l'article 1 hébergées pour notre compte |
| **Fournisseurs RPC Sui** | Lectures/écritures blockchain | Votre adresse et le contenu des transactions (données de chaîne déjà publiques) |
| **Autorités** | Conformité légale | Lorsque le droit applicable l'exige |

Les sous-traitants agissent en vertu de contrats imposant confidentialité et sécurité. Les partenaires d'achat et les fournisseurs OAuth sont responsables de traitement indépendants pour les données qu'ils collectent sur leurs propres plateformes.

## 5. Achats en monnaie fiduciaire (partenaires)

Lorsque vous achetez des crypto-actifs en monnaie fiduciaire, l'opération s'effectue sur la plateforme du partenaire. C'est le partenaire — et non Njangi On-Chain — qui collecte vos informations KYC (documents d'identité, selfies, données de paiement) en vertu de son propre agrément et de sa propre politique de confidentialité. Nous ne recevons jamais ces documents. Nous ne recevons que le statut de l'achat et l'adresse de destination, que nous utilisons pour mettre l'application à jour et, le cas échéant, ancrer une empreinte de conformité opaque sur la chaîne.

## 6. Flux de données d'abonnement Stripe

Si vous souscrivez à l'offre Premium :

1. Vous êtes redirigé vers une page de paiement hébergée par Stripe. Les données de carte y sont saisies et traitées intégralement par Stripe.
2. Stripe nous transmet des événements (« webhooks ») contenant votre identifiant client Stripe, votre identifiant d'abonnement, votre formule et votre statut. Nous les conservons avec votre adresse Sui et vos identifiants OAuth afin d'activer les fonctionnalités Premium.
3. Nous ne recevons ni ne conservons jamais de numéros de carte complets, de cryptogrammes ou d'identifiants bancaires.

Stripe traite vos données de facturation selon sa propre politique de confidentialité et ses certifications (PCI-DSS).

## 7. Les données sur la chaîne sont permanentes — une limite importante

La blockchain Sui est un registre public, en écriture seule, répliqué auprès d'opérateurs indépendants dans le monde entier. **Les données inscrites sur la chaîne — votre adresse de portefeuille, l'historique de vos cercles et transactions, et les empreintes opaques — ne peuvent être ni modifiées ni supprimées, par nous ou par quiconque, à aucun moment.** Il s'agit d'une propriété structurelle des blockchains, et non d'un choix que nous pourrions inverser.

Nous réduisons au minimum ce qui est inscrit sur la chaîne (ni noms, ni numéros de téléphone, ni courriels — uniquement des adresses, des montants et des pointeurs/empreintes opaques). Vous devez néanmoins considérer que toute action de votre adresse sur la chaîne est publique de façon permanente, et que des tiers peuvent tenter de relier des adresses à des identités.

## 8. Durées de conservation

- **Identité OAuth, sel, empreintes de récupération :** conservées tant que votre compte existe ; supprimées sur demande de suppression vérifiée (article 9), sous réserve des limites ci-dessous.
- **Données d'acheminement WhatsApp :** conservées tant que la liaison est active ; accès détruit en cas de déliaison ou de demande de suppression (article 9).
- **Pièces de facturation :** conservées conformément au droit fiscal et comptable (généralement jusqu'à 10 ans).
- **Registres d'acceptation et données nécessaires à la constatation, à l'exercice ou à la défense de droits en justice :** conservés pendant le délai de prescription applicable.
- **Journaux et données techniques :** conservés sur une courte période glissante, puis supprimés ou anonymisés.
- **Données sur la chaîne :** permanentes (article 7).

## 9. Vos droits et le fonctionnement de la suppression

Sous réserve du droit applicable (y compris le droit camerounais de la protection des données et, lorsqu'il s'applique, le RGPD), vous pouvez demander : l'accès à vos données, leur rectification, leur suppression, la limitation du traitement, l'opposition, et une copie portable. Adressez votre demande à {{PRIVACY_CONTACT}} ; nous vérifierons qu'elle émane du titulaire du compte et répondrons dans les délais légaux.

**Ce que fait la suppression :**

- **Les données personnelles hors chaîne sont supprimées.** Les enregistrements contenant vos identifiants OAuth, votre courriel, votre sel, vos empreintes de récupération, l'index HMAC de votre numéro de téléphone, vos demandes d'adhésion et vos préférences sont effacés (à l'exception des registres que la loi nous impose de conserver, p. ex. facturation et acceptations).
- **Les enveloppes WhatsApp chiffrées deviennent définitivement illisibles.** Les blobs Walrus étant immuables, nous supprimons le matériel de clé cryptographique nécessaire à leur déchiffrement. Sans la clé, le texte chiffré est définitivement indéchiffrable, par nous comme par quiconque (effacement cryptographique).
- **Les données sur la chaîne ne peuvent pas être supprimées.** Votre adresse Sui, votre historique de transactions et les empreintes opaques demeurent indéfiniment sur la blockchain publique (article 7). La suppression rompt le lien entre cette adresse et les données d'identité que nous détenions, mais elle n'efface pas — et ne peut pas effacer — la chaîne.
- **Avertissement :** la suppression de votre enregistrement de sel peut rendre votre adresse de portefeuille irrécupérable via le Service. Retirez ou transférez vos fonds avant de demander la suppression.

Si vous estimez que vos droits ont été méconnus, vous pouvez saisir l'autorité de protection des données compétente de votre pays.

## 10. Sécurité

Nous utilisons le chiffrement TLS en transit, AES-256-GCM pour les enveloppes de données personnelles stockées, le hachage avec clé pour les recherches par numéro de téléphone, des contrôles d'accès et une gestion des secrets pour les clés serveur, ainsi que la vérification des signatures sur les webhooks des partenaires. Aucun système n'est parfaitement sûr ; nous vous notifierons, ainsi que l'autorité compétente, toute violation de données personnelles dans les conditions prévues par la loi.

## 11. Transferts internationaux

Nos hébergeurs, les fournisseurs OAuth, Stripe, Meta et les partenaires d'achat peuvent traiter des données en dehors de votre pays, notamment aux États-Unis et dans l'Union européenne. Lorsque cela est requis, nous nous appuyons sur des garanties appropriées (notamment contractuelles) pour ces transferts. Les données de la blockchain et de Walrus sont, par conception, répliquées mondialement.

## 12. Mineurs

Le Service ne s'adresse pas aux personnes de moins de 18 ans et ne peut pas être utilisé par elles. Nous ne traitons pas sciemment de données de mineurs ; si vous pensez que tel est le cas, contactez {{PRIVACY_CONTACT}}.

## 13. Modification de la présente Politique

Nous pouvons mettre à jour la présente Politique. Chaque version porte un numéro de version et une date d'entrée en vigueur. Les modifications substantielles seront notifiées dans l'application et/ou par courriel avant leur entrée en vigueur, et l'application pourra vous demander de prendre acte de la nouvelle version.

## 14. Contact

{{COMPANY_LEGAL_NAME}}, {{COMPANY_ADDRESS}} — {{PRIVACY_CONTACT}}
