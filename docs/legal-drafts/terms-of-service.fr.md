---
title: "Njangi on Chain — Conditions Générales d'Utilisation"
version: 1.0.0
effective_date: "{{EFFECTIVE_DATE}}"
language: fr
---

> **DRAFT — requires review by qualified counsel before publication.**
> **PROJET — doit être revu par un conseil juridique qualifié avant publication.**
> Le présent document est un projet professionnel destiné à une revue interne. Il ne constitue pas un avis juridique.
> Champs à compléter avant publication : `{{EFFECTIVE_DATE}}`, `{{GOVERNING_LAW}}`,
> `{{COMPANY_LEGAL_NAME}}`, `{{COMPANY_ADDRESS}}`, `{{PRIVACY_CONTACT}}`, `{{CONTROLLING_LANGUAGE}}`.

# Conditions Générales d'Utilisation

**Version 1.0.0 — Date d'entrée en vigueur : {{EFFECTIVE_DATE}}**

Les présentes Conditions Générales d'Utilisation (les « Conditions ») constituent un contrat entre vous et {{COMPANY_LEGAL_NAME}}, {{COMPANY_ADDRESS}} (« Njangi », « nous »), exploitant du site, des applications et des services associés Njangi on Chain (ensemble, le « Service »). En créant un compte, en acceptant les présentes Conditions dans l'application ou en utilisant le Service, vous acceptez d'être lié par celles-ci. Si vous ne les acceptez pas, n'utilisez pas le Service.

Les présentes Conditions sont disponibles en français et en anglais. Les deux versions vous sont fournies ; en cas de divergence, la version en {{CONTROLLING_LANGUAGE}} prévaut dans la mesure permise par le droit applicable.

## 1. Ce que le Service est — et ce qu'il n'est pas

Njangi on Chain est un **logiciel de coordination** destiné aux groupes d'épargne rotative auto-organisés (connus sous les noms de tontines, njangis ou AREC/ROSCA). Le Service fournit une interface vers des contrats intelligents (« smart contracts ») déployés sur la blockchain Sui, permettant à un groupe de personnes que vous choisissez de :

- créer un cercle d'épargne avec des montants de cotisation convenus et un ordre de rotation ;
- verser des crypto-actifs (stablecoins ou SUI) dans un **séquestre par cycle** détenu par le contrat intelligent ;
- permettre au bénéficiaire désigné de chaque cycle de réclamer la cagnotte du cycle ;
- utiliser des fonctionnalités de coordination telles que les notifications WhatsApp, les objectifs et les statistiques.

**Njangi n'est ni une banque, ni un établissement de crédit, ni un établissement de microfinance, ni un établissement collecteur de dépôts, ni un transmetteur de fonds, ni un prestataire de services de paiement, ni un émetteur de monnaie électronique, ni un courtier, ni une plateforme d'échange, ni un conseiller en investissement.** Nous ne sommes agréés ni supervisés en qualité d'établissement financier dans aucune juridiction, y compris par la BEAC ou la COBAC dans la zone CEMAC. Nous ne recevons pas de dépôts, ne détenons pas de fonds de clients, n'octroyons pas de crédit, ne versons pas d'intérêts et n'offrons aucun rendement ou produit d'investissement. **Le Service ne comporte aucun produit de rendement ou d'intérêt, de quelque nature que ce soit.**

Nous ne fournissons aucun conseil financier, d'investissement, fiscal ou juridique. Rien dans le Service ne constitue une recommandation de rejoindre un cercle ou d'acheter, conserver ou vendre un crypto-actif.

## 2. Conditions d'accès

Pour utiliser le Service, vous devez :

- être âgé d'au moins **18 ans** et avoir la capacité juridique de contracter ;
- ne pas être situé dans, ni résident d'une juridiction où l'utilisation du Service est illicite, et ne pas utiliser le Service en violation des lois qui vous sont applicables ;
- ne pas faire l'objet de sanctions ni figurer sur une liste de sanctions ou de personnes interdites applicable ;
- utiliser le Service pour votre propre compte et non pour le compte d'un tiers (sauf en qualité de représentant dûment habilité).

Il vous appartient exclusivement de vérifier que votre participation à un cercle d'épargne et votre utilisation de crypto-actifs sont licites dans votre juridiction.

## 3. Votre compte et votre portefeuille (zkLogin)

Le Service utilise zkLogin : l'adresse de votre portefeuille sur la blockchain Sui est dérivée de votre compte Google, Facebook ou Apple. Il n'existe pas de mot de passe distinct et **nous ne détenons pas vos clés privées**.

Vous reconnaissez et acceptez que :

- **si vous perdez l'accès au compte social utilisé pour vous connecter, vous pouvez perdre définitivement l'accès à votre portefeuille et aux fonds qu'il contrôle.** Les codes de récupération proposés par le Service n'atténuent ce risque que si vous les générez et les conservez en lieu sûr ;
- vous êtes seul responsable de la sécurité de votre compte social (mot de passe robuste, authentification à deux facteurs) et de vos codes de récupération ;
- toute transaction signée depuis votre portefeuille est réputée autorisée par vous ;
- nous ne pouvons ni réinitialiser, ni restaurer, ni transférer votre portefeuille à votre place.

## 4. Architecture non dépositaire ; absence de contrôle sur les fonds

Le Service est **non dépositaire** (« non-custodial »). Les fonds versés à un cercle sont détenus par des contrats intelligents sur la blockchain Sui, sous séquestre pour le cycle en cours, selon des règles fixées dans le code publié du contrat. Njangi :

- **ne peut pas déplacer, geler, saisir, réorienter ni récupérer les fonds des utilisateurs de manière discrétionnaire.** Les contrats ne comportent aucune fonction administrative le permettant ;
- ne prend à aucun moment possession des cotisations ou des paiements ;
- ne peut ni annuler, ni inverser, ni modifier une transaction blockchain confirmée ;
- ne peut pas vous indemniser des fonds perdus sur la chaîne.

Les paiements sont **sans permission et à l'initiative des membres** : le bénéficiaire désigné réclame la cagnotte du cycle directement auprès du contrat. Un mécanisme de récupération à l'initiative des membres existe dans les contrats pour certains scénarios de défaillance ; son fonctionnement est régi exclusivement par le code du contrat, et Njangi ne peut ni le déclencher, ni l'accélérer, ni s'y substituer pour votre compte.

**Il n'existe aucune assurance des dépôts.** Les fonds des cercles ne sont protégés par aucun système public de garantie des dépôts, et personne — y compris Njangi — n'en garantit la restitution.

La suspension ou la résiliation de votre accès à l'interface du Service (article 12) est sans effet sur les contrats intelligents, qui demeurent accessibles sur le réseau public Sui indépendamment de Njangi.

## 5. Cercles d'épargne ; litiges entre membres

Les cercles d'épargne sont des arrangements privés **entre leurs membres**. Vous choisissez les personnes avec lesquelles vous formez un cercle. Vous reconnaissez que :

- **Njangi ne vérifie, ne cautionne et ne garantit aucun membre d'un cercle**, n'assume aucun risque de contrepartie et n'est partie à aucun cercle ;
- un cercle ne s'achève que si ses membres continuent de cotiser ; un membre qui cesse de cotiser peut retarder ou empêcher les paiements, y compris le vôtre ;
- les dépôts de garantie et autres paramètres du cercle sont appliqués exclusivement tels qu'encodés dans les contrats intelligents ;
- tout litige entre membres d'un cercle (y compris le défaut de paiement, l'ordre des paiements ou l'exclusion d'un membre) relève des seuls membres concernés. Njangi n'a ni l'obligation ni, dans un système non dépositaire, la capacité technique de trancher ou de réparer de tels litiges en déplaçant des fonds.

Vous vous engagez à agir de bonne foi envers les membres de votre cercle et à n'utiliser les cercles qu'avec des personnes avec lesquelles vous avez un véritable accord d'épargne.

## 6. Crypto-actifs ; reconnaissance des risques

Les cotisations et les paiements s'effectuent en crypto-actifs (stablecoins ou SUI) sur le réseau Sui (testnet ou mainnet, selon l'indication dans l'application). Vous reconnaissez les risques décrits dans la **Déclaration des Risques**, qui fait partie intégrante des présentes Conditions, notamment : la volatilité des cours (y compris la perte d'ancrage des stablecoins), l'irréversibilité des transactions, les défauts des contrats intelligents, les erreurs d'oracles ou de flux de prix, les défaillances du réseau blockchain, la perte d'accès au portefeuille et l'incertitude réglementaire. **Vous pouvez perdre tout ou partie de la valeur que vous versez.**

Les fonctionnalités identifiées comme fonctionnant sur le **testnet** utilisent des jetons sans valeur monétaire et sont fournies à des fins d'évaluation uniquement.

## 7. Achats en monnaie fiduciaire via des partenaires

Si vous achetez des crypto-actifs en monnaie fiduciaire par l'intermédiaire du Service, l'achat est exécuté **sur la plateforme d'un partenaire indépendant** (tel que Coinbase, MoonPay ou Transak), selon les conditions, frais et agréments propres à ce partenaire. C'est le partenaire — et non Njangi — qui procède à la vérification d'identité (KYC) et aux contrôles de lutte contre le blanchiment. **Njangi ne reçoit, ne détient ni ne règle jamais vos fonds fiduciaires.** Nous ne sommes pas responsables des actes, omissions, frais, retards, refus ou de la disponibilité d'un partenaire dans votre pays. Une confirmation indiquant qu'un partenaire a achevé ses contrôles peut être enregistrée sur la chaîne, exclusivement sous la forme d'une empreinte cryptographique opaque ne contenant aucune donnée personnelle.

## 8. Abonnements et facturation

L'essentiel du Service est disponible dans une **offre Gratuite** (actuellement : un cercle comptant jusqu'à trois membres). Un **abonnement Premium** (actuellement **9,99 USD par mois**) débloque des fonctionnalités de coordination telles que des cercles plus grands et plus nombreux, les notifications WhatsApp, les objectifs intelligents et les statistiques.

- **Facturation.** Les abonnements sont facturés via **Stripe**, notre prestataire de paiement. Vos données de carte et de paiement sont collectées et traitées par Stripe selon ses propres conditions et sa propre politique de confidentialité ; Njangi ne reçoit jamais vos données de carte complètes.
- **Renouvellement et résiliation.** Les abonnements se renouvellent automatiquement à chaque période de facturation. Vous pouvez **résilier à tout moment** ; la résiliation prend effet à la **fin de la période de facturation en cours**, et vous conservez les fonctionnalités Premium jusqu'à cette date. Sauf disposition légale contraire, les sommes déjà versées ne sont pas remboursées au prorata.
- **Évolution des prix.** Toute modification de prix vous sera notifiée au moins 30 jours à l'avance ; elle s'applique à compter de la période de facturation suivant la notification.
- **Ce qui n'est jamais payant.** L'accès à vos fonds n'est jamais conditionné à un paiement. **La réclamation d'un paiement, le retrait ou la récupération de fonds, ainsi que le mécanisme de récupération à l'initiative des membres, sont disponibles dans toutes les offres, sans frais de la part de Njangi, à tout moment.** En cas d'expiration de votre abonnement, vous ne perdez que les fonctionnalités de coordination Premium.
- Les frais de réseau (« gas ») et les frais des partenaires (article 7) sont indépendants de tout abonnement Njangi.

## 9. Utilisations interdites

Vous vous interdisez de :

- utiliser le Service à des fins illicites, notamment le blanchiment de capitaux, le financement du terrorisme, le contournement de sanctions, la fraude ou les montages pyramidaux/Ponzi ;
- travestir votre identité, usurper l'identité d'autrui ou créer des comptes pour des personnes de moins de 18 ans ;
- tromper, frauder ou contraindre des membres d'un cercle, ou organiser des cercles que vous n'avez pas l'intention d'honorer ;
- tenter d'exploiter, de manipuler ou de perturber les contrats intelligents, le Service ou les portefeuilles d'autres utilisateurs, ou introduire un code malveillant ;
- extraire massivement (« scraper »), revendre ou exploiter commercialement le Service sans notre accord écrit ;
- contourner toute mesure d'accès, de limitation de débit ou de sécurité ;
- utiliser le Service depuis une juridiction où il est interdit, ou pour échapper aux contrôles de conformité d'un partenaire.

Nous pouvons suspendre ou résilier l'accès à l'interface en cas de manquement (article 12). Le système étant non dépositaire, une suspension ne confisque pas — et ne peut pas confisquer — des fonds sur la chaîne.

## 10. Propriété intellectuelle

Le logiciel, la marque et les contenus du Service appartiennent à Njangi ou à ses concédants. Les composants open source, y compris le code publié des contrats intelligents, demeurent régis par leurs licences respectives. Nous vous concédons une licence limitée, révocable, non exclusive et non cessible d'utilisation du Service conformément à sa destination. Vous conservez vos droits sur les contenus que vous soumettez et nous concédez une licence pour les traiter dans la mesure nécessaire au fonctionnement du Service.

## 11. Services de tiers

Le Service interagit avec des tiers que nous ne contrôlons pas, notamment le réseau Sui et ses validateurs, le stockage décentralisé Walrus, les fournisseurs OAuth (Google, Facebook, Apple), la plateforme WhatsApp Business de Meta, Stripe, les partenaires d'achat de crypto-actifs et les oracles de prix. Leur disponibilité et leur comportement échappent à notre contrôle, et votre utilisation de leurs services peut être soumise à leurs propres conditions. Dans toute la mesure permise par la loi, nous déclinons toute responsabilité au titre des services de tiers.

## 12. Suspension et résiliation

Vous pouvez cesser d'utiliser le Service à tout moment. Nous pouvons suspendre ou résilier votre accès à l'interface du Service, moyennant notification lorsque cela est possible, en cas de manquement aux présentes Conditions, d'obligation légale, ou de risque juridique ou de sécurité. Les stipulations qui, par nature, doivent survivre (notamment les articles 4, 5 et 13 à 16) survivent à la résiliation. **La résiliation de l'accès à l'interface ne bloque pas vos fonds sur la chaîne** : les contrats demeurent publiquement accessibles, et les fonctions de réclamation et de récupération restent exécutables sur le réseau Sui.

## 13. Exclusions de garantie

LE SERVICE, Y COMPRIS LES CONTRATS INTELLIGENTS ET TOUTE INFORMATION AFFICHÉE (NOTAMMENT LES PRIX ET LES SOLDES), EST FOURNI **« EN L'ÉTAT » ET « SELON DISPONIBILITÉ »**, SANS GARANTIE D'AUCUNE SORTE, EXPRESSE OU IMPLICITE, Y COMPRIS LES GARANTIES DE QUALITÉ MARCHANDE, D'ADÉQUATION À UN USAGE PARTICULIER, D'ABSENCE DE CONTREFAÇON, D'EXACTITUDE OU DE FONCTIONNEMENT ININTERROMPU. NOUS NE GARANTISSONS NI L'ABSENCE DE DÉFAUTS DANS LES CONTRATS INTELLIGENTS NI L'ACHÈVEMENT D'UN CERCLE. CERTAINES JURIDICTIONS N'AUTORISENT PAS CERTAINES EXCLUSIONS DE GARANTIE ; DANS CE CAS, ELLES S'APPLIQUENT DANS TOUTE LA MESURE PERMISE.

## 14. Limitation de responsabilité

Dans toute la mesure permise par le droit applicable :

- Njangi, ses dirigeants, salariés et mandataires ne sont **pas responsables des dommages indirects, accessoires, spéciaux, consécutifs ou punitifs**, ni des pertes de profits, de données, de clientèle ou de crypto-actifs, découlant du Service ou s'y rapportant ;
- Njangi n'est **pas responsable** : des pertes causées par le comportement des membres d'un cercle (y compris le défaut de cotisation ou la fraude) ; des défaillances du réseau blockchain ou de ses validateurs ; des défauts ou exploitations des contrats intelligents ; des erreurs d'oracles ou de flux de prix ; de la perte d'accès à votre connexion sociale ou à vos codes de récupération ; des actes ou omissions des services de tiers (article 11) ; ou des événements échappant à notre contrôle raisonnable ;
- **la responsabilité cumulée de Njangi** au titre de l'ensemble des réclamations liées au Service est limitée au **plus élevé des deux montants suivants : (a) les frais d'abonnement que vous avez versés à Njangi au cours des douze (12) mois précédant le fait générateur, et (b) cent (100) dollars US**.

Aucune stipulation des présentes Conditions n'exclut ni ne limite une responsabilité qui ne peut être exclue ou limitée en vertu du droit applicable, notamment la responsabilité pour dol, faute intentionnelle ou faute lourde lorsque cette limitation n'est pas permise.

## 15. Garantie d'indemnisation

Vous vous engagez à indemniser et à garantir Njangi ainsi que ses dirigeants, salariés et mandataires contre toute réclamation, tout dommage et tous frais raisonnables (y compris les honoraires d'avocat) résultant de votre violation des présentes Conditions, de votre violation du droit applicable ou de vos litiges avec des membres de cercles ou d'autres tiers, sauf dans la mesure où ils résultent de notre propre manquement ou de notre propre faute.

## 16. Droit applicable et litiges

Les présentes Conditions sont régies par le droit de **{{GOVERNING_LAW}}**, sans égard à ses règles de conflit de lois. Les juridictions de {{GOVERNING_LAW}} sont compétentes pour connaître des litiges nés des présentes Conditions, sous réserve des règles impératives de protection des consommateurs vous reconnaissant le droit d'agir devant les juridictions de votre lieu de résidence. Les parties s'efforceront de bonne foi de résoudre tout litige à l'amiable avant d'engager une procédure.

## 17. Modification des Conditions

Nous pouvons modifier les présentes Conditions. Chaque version porte un numéro de version et une date d'entrée en vigueur. En cas de **modification substantielle**, nous vous en informerons dans l'application et/ou par courriel au moins **30 jours** avant l'entrée en vigueur de la nouvelle version, et l'application vous demandera de **consulter et d'accepter la nouvelle version** avant de continuer à utiliser les fonctionnalités concernées. À défaut d'acceptation, vous devez cesser d'utiliser le Service ; vos fonds sur la chaîne demeurent réclamables conformément à l'article 12. La version en vigueur et les versions antérieures restent consultables dans l'application.

## 18. Stipulations diverses

- **Fiscalité.** Vous êtes seul responsable des impôts et taxes résultant de votre participation à un cercle ou de vos opérations sur crypto-actifs.
- **Divisibilité.** Si une stipulation est jugée nulle, les autres demeurent applicables.
- **Cession.** Vous ne pouvez pas céder les présentes Conditions ; nous pouvons les céder dans le cadre d'une réorganisation ou d'un transfert du Service, moyennant notification.
- **Intégralité de l'accord.** Les présentes Conditions, la Politique de Confidentialité et la Déclaration des Risques constituent l'intégralité de l'accord entre vous et Njangi relatif au Service.
- **Non-renonciation.** Le défaut d'exercice d'un droit ne vaut pas renonciation à celui-ci.

## 19. Contact

{{COMPANY_LEGAL_NAME}}, {{COMPANY_ADDRESS}} — {{PRIVACY_CONTACT}}
