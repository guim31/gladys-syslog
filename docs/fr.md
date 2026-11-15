# Syslog

Votre box, votre NAS, votre onduleur, vos switchs et vos serveurs écrivent tous
des journaux, et presque tous savent les envoyer sur le réseau avec **syslog**.
Cette intégration fait de Gladys un récepteur syslog : chaque appareil qui
envoie ses journaux devient un appareil Gladys avec son dernier message, sa
dernière sévérité et ses erreurs de la dernière heure. Des règles repèrent les
messages qui comptent (« connexion VPN », « disque en erreur », « coupure
secteur »…) et déclenchent des scènes, et un widget du tableau de bord liste les
derniers messages graves.

Rien n'est conservé : Gladys garde en mémoire le dernier message de chaque
appareil, les derniers messages graves, et des compteurs. Ce n'est pas une
archive de journaux (pour cela, voir Graylog).

Testé avec de vrais émetteurs syslog (`logger`, rsyslog 8 en relais, RFC 3164
et RFC 5424, UDP et TCP) contre l'image Docker de l'intégration ; pas encore sur
une vraie instance Gladys : vos retours sont les bienvenus sur
[les issues](https://github.com/guim31/gladys-syslog/issues).

## Ce qu'il vous faut

- Gladys Assistant 5.2.0 ou plus récent.
- Des appareils capables d'envoyer leurs journaux à un « serveur syslog
  distant », en UDP ou en TCP, sur un port réglable. La plupart des box, NAS
  (Synology, QNAP, TrueNAS…), logiciels d'onduleur (NUT, apcupsd), switchs,
  pare-feu et serveurs Linux (rsyslog, syslog-ng, journald) le savent.

## Prise en main

### 1. Installer l'intégration

Dans Gladys, **Intégrations → Installer depuis GitHub**, adresse
`https://github.com/guim31/gladys-syslog`. L'intégration démarre deux
conteneurs : l'intégration elle-même et un petit **récepteur** qui écoute le
syslog. Gladys choisit les ports sur lesquels le récepteur est joignable, un en
UDP et un en TCP : l'écran de configuration de l'intégration les affiche, dans
la section « Envoyez vos journaux à Gladys ».

### 2. Faire pointer vos appareils vers Gladys

Dans les réglages syslog (ou « journalisation distante ») de chaque appareil,
indiquez l'adresse de la machine Gladys et le port UDP affiché par l'écran de
configuration. L'UDP est ce que presque tous les appareils proposent ; le TCP (le second port) ne perd pas de messages en route et convient à rsyslog et syslog-ng. Les
deux découpages TCP, « octet counting » et « un message par ligne », sont
compris.

Sur un serveur Linux avec rsyslog, une ligne dans `/etc/rsyslog.d/gladys.conf`
suffit (remplacez l'adresse et le port) :

```
*.* @192.168.1.10:41234
```

`@` envoie en UDP, `@@` en TCP. Pour tester depuis n'importe quelle machine
Linux :

```
logger -n 192.168.1.10 -P 41234 --udp "Bonjour Gladys"
```

### 3. Un appareil qui n'envoie que vers le port 514

Certaines box ne laissent pas choisir le port : elles envoient toujours vers le
port 514. Deux solutions :

- **Un relais** (recommandé) : un rsyslog qui écoute le port 514, sur une
  machine du réseau (un NAS, un Raspberry Pi…), et transmet tout à Gladys :

  ```
  module(load="imudp")
  input(type="imudp" port="514")
  *.* action(type="omfwd" target="192.168.1.10" port="41234" protocol="udp"
             template="RSYSLOG_SyslogProtocol23Format")
  ```

  Indiquez ensuite l'adresse IP du relais dans **Relais de confiance** : les
  messages qu'il transmet sont classés par le nom d'hôte qu'ils portent, et
  chaque appareil derrière le relais reste un appareil à part. (Sans cela, ils
  ressembleraient tous au relais.) Un relais sur la machine Gladys elle-même
  joint le récepteur à travers Docker, sous une autre adresse : le paramètre IP
  des appareils qu'il a transmis avant que vous le déclariez l'indique.

- **Une redirection de port** sur la machine Gladys (iptables), du 514 vers le
  port choisi. Elle masque l'adresse de l'émetteur à l'intégration sur la
  plupart des installations Docker : préférez le relais.

### 4. Ajouter les appareils

Chaque appareil qui envoie un message apparaît dans l'onglet **Découverte** de
l'intégration, nommé d'après le nom d'hôte qu'il envoie (ou son adresse IP).
Ajoutez ceux que vous voulez suivre. L'intégration reconnaît un appareil à son
adresse IP : donnez une adresse fixe à vos appareils (réservation DHCP).

Le bouton **Oublier les émetteurs non ajoutés** de la configuration vide
l'onglet Découverte des appareils que vous n'avez pas ajoutés ; ils reviennent
avec leur prochain message.

## Configuration

- **Émetteurs autorisés** : adresses IP ou plages IPv4 (`192.168.1.0/24`),
  séparées par des virgules. Vide : tout émetteur est accepté. Un message d'une autre adresse est ignoré par le récepteur. Conseillé : syslog n'a pas d'authentification, et un hôte du réseau pourrait sinon remplir les 200 émetteurs d'adresses usurpées.
- **Relais de confiance** : voir plus haut.
- **Messages par seconde par émetteur** (20 par défaut) : au-delà, les messages
  de cet émetteur sont ignorés (une rafale du double est acceptée). Un appareil
  qui s'emballe ne peut pas saturer Gladys. Le récepteur accepte aussi 500
  messages par seconde au plus, tous émetteurs confondus.
- **Langue des noms et des textes** : les noms des fonctionnalités (figés à
  l'ajout d'un appareil), les sévérités et les variables de scène.
- **Règles** : jusqu'à cinq, voir plus bas.

## Sévérités

Chaque message syslog porte une sévérité, de la plus à la moins grave :
Urgence, Alerte, Critique, Erreur, Avertissement, Notification, Information,
Débogage. Un message qui n'en a pas compte comme Notification. L'intégration
appelle « grave » un message Avertissement ou plus grave, et « erreur » un
message Erreur ou plus grave.

## Les appareils

Chaque émetteur :

- **Dernier message** : le programme et le texte de son dernier message.
- **Dernière sévérité** : la sévérité de son dernier message.
- **Erreurs sur la dernière heure** : ses messages Erreur ou plus graves des 60
  dernières minutes.
- **Vu pour la dernière fois** : l'heure de son dernier message.

L'appareil **Règles syslog** a un compteur par règle, nommé comme la règle : les
messages qui lui ont correspondu dans les 60 dernières minutes. Utilisez-les
dans les conditions de scène (« plus de 5 échecs de connexion dans l'heure »).

Les états partent vers Gladys toutes les 15 secondes au plus, seulement quand
ils changent : Gladys accepte 300 états par minute.

## Règles

Une règle a :

- un **nom**, celui de son compteur et une variable de son déclencheur de
  scène ;
- un **texte**, cherché dans le message sans tenir compte de la casse, ou une
  **expression régulière** entre barres obliques : `/disk \S+ failed/i` (`i` :
  sans tenir compte de la casse). Le message est lu sous la forme
  `programme: texte`, une règle peut donc nommer le programme :
  `openvpn: .* Peer Connection Initiated` ;
- une **sévérité** minimale (Toutes par défaut) ;
- des **émetteurs**, facultatifs : adresses IP ou noms d'hôte, séparés par des
  virgules.

Exemples : `Peer Connection Initiated` (connexion OpenVPN), `on battery` (NUT,
coupure secteur), `authentication failure` (échec de connexion),
`/ata\d.*failed/` (erreur disque dans le journal du noyau).

## Tableau de bord

Le widget **Messages graves** affiche :

- les erreurs de la dernière heure, tous émetteurs confondus ;
- les derniers messages graves, du plus récent au plus ancien : le texte,
  l'émetteur et l'heure, la sévérité en pastille de couleur ; touchez un message
  pour le lire en entier ;
- un bouton **Effacer** : une fois lue, la liste n'affiche plus que les nouveaux
  messages.

Réglages : les émetteurs (vide : tous), la sévérité minimale affichée (Erreur
par défaut), et des interrupteurs pour masquer le compteur et le bouton
Effacer. Les messages graves ne sont gardés qu'en mémoire : un redémarrage de
l'intégration vide la liste.

## Scènes

### Déclencheurs

- **Une règle correspond** : un message correspond à une règle. Filtres : les
  règles, les émetteurs. Variables : nom de la règle, émetteur, adresse IP,
  sévérité, programme, message.
- **Un message grave arrive** : un émetteur journalise un Avertissement ou plus
  grave. Filtres : les sévérités, les émetteurs. Mêmes variables, sans la
  règle.
- **Un nouvel émetteur apparaît** : un appareil jamais vu envoie son premier
  message (un nouvel appareil sur le réseau, ou un appareil mal réglé).
  Variables : émetteur, adresse IP.

Pour éviter les avalanches, un déclencheur part au plus une fois toutes les 10
secondes pour la même règle et le même émetteur (ou le même émetteur et la même
sévérité), et l'intégration envoie 120 événements de scène par minute au plus.

### Idées de scènes

- « Coupure secteur » : règle `on battery` → envoyer un message et éteindre ce
  qui peut l'être.
- « Quelqu'un s'est connecté au VPN » : règle `Peer Connection Initiated` → une
  notification avec `{{triggerEvent.data.message}}`.
- « Le NAS signale une erreur disque » : le déclencheur « Un message grave
  arrive », sévérités Critique et Erreur, émetteur le NAS.

## Dépannage

- **Aucun appareil n'apparaît** : vérifiez que l'appareil envoie vers le bon
  port (celui de l'écran de configuration, pas 514) et vers l'adresse IP de la
  machine Gladys ; testez avec `logger` depuis un ordinateur. Vérifiez les
  Émetteurs autorisés.
- **L'écran de configuration affiche `{{port:syslog_udp}}`** : le récepteur
  n'a pas encore démarré ; rechargez la page quelques secondes après
  l'installation.
- **Tous les appareils ont la même adresse** : ils passent par un relais, ou
  Gladys fait tourner Docker avec un réseau qui masque l'adresse de l'émetteur.
  Utilisez les Relais de confiance.
- **Des messages manquent** : un émetteur au-dessus de sa limite est signalé
  dans les logs de l'intégration ; augmentez « Messages par seconde par
  émetteur ». L'UDP peut perdre des messages sur un réseau chargé : utilisez le
  TCP.
- **Le statut est rouge** : le conteneur du récepteur ne tourne pas
  (l'intégration le redémarre d'elle-même), une expression régulière d'une règle
  est invalide, ou un émetteur autorisé est incompris : le message dit lequel.

## Limites

- L'heure d'un message est celle de sa réception : les horloges des appareils
  sont souvent fausses, et l'ancien format syslog n'a ni année ni fuseau.
- Un appareil est reconnu à son adresse IP : un appareil dont l'adresse change
  réapparaît dans Découverte.
- Pas de TLS (syslog sur TLS, port 6514) : le récepteur est fait pour le réseau
  local.
- 200 émetteurs au plus ; les messages sont coupés à 2 048 caractères.
- Rien n'est archivé : pour chercher dans d'anciens journaux, utilisez un
  serveur de journaux (Graylog…).
- Sans lien avec aucune des marques citées.
