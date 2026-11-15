# Syslog

Dein Router, dein NAS, deine USV, deine Switches und deine Server schreiben
Protokolle, und fast alle können sie mit **Syslog** über das Netzwerk schicken.
Diese Integration macht Gladys zum Syslog-Empfänger: Jedes Gerät, das seine
Protokolle schickt, wird zu einem Gladys-Gerät mit seiner letzten Meldung,
seinem letzten Schweregrad und seinen Fehlern der letzten Stunde. Regeln
erkennen die wichtigen Meldungen („VPN-Verbindung“, „Festplattenfehler“,
„Stromausfall“…) und lösen Szenen aus, und ein Dashboard-Widget listet die
letzten schweren Meldungen auf.

Nichts wird gespeichert: Gladys behält die letzte Meldung jedes Geräts und die
letzten schweren Meldungen im Speicher, dazu Zähler. Es ist kein
Protokollarchiv (dafür siehe Graylog).

Getestet mit echten Syslog-Absendern (`logger`, rsyslog 8 als Relay, RFC 3164
und RFC 5424, UDP und TCP) gegen das Docker-Image der Integration; noch nicht
auf einer echten Gladys-Instanz: Rückmeldungen sind willkommen in
[den Issues](https://github.com/guim31/gladys-syslog/issues).

## Was du brauchst

- Gladys Assistant 5.2.0 oder neuer.
- Geräte, die ihre Protokolle an einen „entfernten Syslog-Server“ schicken
  können, per UDP oder TCP, mit einstellbarem Port. Die meisten Router, NAS
  (Synology, QNAP, TrueNAS…), USV-Programme (NUT, apcupsd), Switches, Firewalls
  und Linux-Server (rsyslog, syslog-ng, journald) können das.

## Erste Schritte

### 1. Die Integration installieren

In Gladys **Integrationen → Von GitHub installieren**, Adresse
`https://github.com/guim31/gladys-syslog`. Die Integration startet zwei
Container: die Integration selbst und einen kleinen **Empfänger**, der auf
Syslog hört. Gladys wählt die Ports, unter denen der Empfänger erreichbar ist,
einen für UDP und einen für TCP: Der Konfigurationsbildschirm der Integration
zeigt sie im Abschnitt „Schicke deine Protokolle an Gladys“.

### 2. Deine Geräte auf Gladys richten

Trage in den Syslog-Einstellungen (oder „Remote-Protokollierung“) jedes Geräts
die Adresse des Gladys-Rechners und den UDP-Port ein, den der
Konfigurationsbildschirm zeigt. UDP bietet fast jedes Gerät an; TCP (der zweite
Port) verliert keine Meldungen und passt zu rsyslog und syslog-ng. Beide
TCP-Aufteilungen, „Octet Counting“ und „eine Meldung pro Zeile“, werden
verstanden.

Auf einem Linux-Server mit rsyslog reicht eine Zeile in
`/etc/rsyslog.d/gladys.conf` (Adresse und Port ersetzen):

```
*.* @192.168.1.10:41234
```

`@` schickt per UDP, `@@` per TCP. Zum Testen von einem beliebigen
Linux-Rechner:

```
logger -n 192.168.1.10 -P 41234 --udp "Hallo Gladys"
```

### 3. Ein Gerät, das nur an Port 514 sendet

Manche Router lassen den Port nicht wählen und senden immer an Port 514. Zwei
Lösungen:

- **Ein Relay** (empfohlen): ein rsyslog, das auf Port 514 hört, auf einem
  Rechner im Netzwerk (ein NAS, ein Raspberry Pi…), und alles an Gladys
  weiterleitet:

  ```
  module(load="imudp")
  input(type="imudp" port="514")
  *.* action(type="omfwd" target="192.168.1.10" port="41234" protocol="udp"
             template="RSYSLOG_SyslogProtocol23Format")
  ```

  Trage dann die IP-Adresse des Relays unter **Vertrauenswürdige Relays** ein:
  Die weitergeleiteten Meldungen werden nach ihrem Hostnamen sortiert, und jedes
  Gerät hinter dem Relay bleibt ein eigenes Gerät. (Ohne das sähen sie alle wie
  das Relay aus.) Ein Relay auf dem Gladys-Rechner selbst erreicht den Empfänger
  über Docker, unter einer anderen Adresse: Der IP-Parameter der Geräte, die es
  weitergeleitet hat, bevor du es eingetragen hast, zeigt welche.

- **Eine Portumleitung** auf dem Gladys-Rechner (iptables), von 514 auf den
  gewählten Port. Diese verbirgt in den meisten Docker-Installationen die Adresse
  des Absenders vor der Integration: Nimm lieber das Relay.

### 4. Die Geräte hinzufügen

Jedes Gerät, das eine Meldung schickt, erscheint im Tab **Entdecken** der
Integration, benannt nach dem Hostnamen, den es schickt (oder seiner
IP-Adresse). Füge die hinzu, die du verfolgen willst. Die Integration erkennt
ein Gerät an seiner IP-Adresse: Gib deinen Geräten eine feste Adresse
(DHCP-Reservierung).

Die Schaltfläche **Nicht hinzugefügte Absender vergessen** der Konfiguration
leert den Tab „Entdecken“ von den Geräten, die du nicht hinzugefügt hast; sie
kommen mit ihrer nächsten Meldung zurück.

## Konfiguration

- **Erlaubte Absender**: IP-Adressen oder IPv4-Bereiche (`192.168.1.0/24`),
  durch Kommas getrennt. Leer: Jeder Absender wird angenommen. Eine Meldung von
  einer anderen Adresse verwirft der Empfänger.
- **Vertrauenswürdige Relays**: siehe oben.
- **Meldungen pro Sekunde je Absender** (standardmäßig 20): Darüber werden die
  Meldungen dieses Absenders verworfen (ein Schub der doppelten Menge wird
  angenommen). Ein durchdrehendes Gerät kann Gladys nicht überfluten. Der
  Empfänger nimmt außerdem höchstens 500 Meldungen pro Sekunde an, alle Absender
  zusammen.
- **Sprache der Namen und Texte**: die Namen der Funktionen (beim Hinzufügen
  eines Geräts festgelegt), die Schweregrade und die Szenenvariablen.
- **Regeln**: bis zu fünf, siehe unten.

## Schweregrade

Jede Syslog-Meldung trägt einen Schweregrad, vom schwersten zum leichtesten:
Notfall, Alarm, Kritisch, Fehler, Warnung, Hinweis, Info, Debug. Eine Meldung
ohne Schweregrad zählt als Hinweis. Die Integration nennt eine Meldung „schwer“
ab Warnung und einen „Fehler“ ab Fehler.

## Die Geräte

Jeder Absender:

- **Letzte Meldung**: das Programm und der Text seiner letzten Meldung.
- **Letzter Schweregrad**: der Schweregrad seiner letzten Meldung.
- **Fehler in der letzten Stunde**: seine Meldungen ab Fehler in den letzten 60
  Minuten.
- **Zuletzt gesehen**: die Uhrzeit seiner letzten Meldung.

Das Gerät **Syslog-Regeln** hat einen Zähler pro Regel, benannt wie die Regel:
die Meldungen, die in den letzten 60 Minuten auf sie zutrafen. Nutze sie in
Szenenbedingungen („mehr als 5 fehlgeschlagene Anmeldungen in der letzten
Stunde“).

Die Zustände gehen höchstens alle 15 Sekunden an Gladys, nur wenn sie sich
ändern: Gladys nimmt 300 Zustände pro Minute an.

## Regeln

Eine Regel hat:

- einen **Namen**, den ihres Zählers und eine Variable ihres Szenenauslösers;
- einen **Text**, ohne Groß-/Kleinschreibung in der Meldung gesucht, oder einen
  **regulären Ausdruck** zwischen Schrägstrichen: `/disk \S+ failed/i` (`i`:
  ohne Groß-/Kleinschreibung). Die Meldung wird als `Programm: Text` gelesen,
  eine Regel kann also das Programm nennen:
  `openvpn: .* Peer Connection Initiated`;
- einen minimalen **Schweregrad** (standardmäßig Alle);
- optional **Absender**: IP-Adressen oder Hostnamen, durch Kommas getrennt.

Beispiele: `Peer Connection Initiated` (OpenVPN-Verbindung), `on battery` (NUT,
Stromausfall), `authentication failure` (fehlgeschlagene Anmeldung),
`/ata\d.*failed/` (Festplattenfehler im Kernel-Protokoll).

## Dashboard

Das Widget **Schwere Meldungen** zeigt:

- die Fehler der letzten Stunde, alle Absender zusammen;
- die letzten schweren Meldungen, die neuesten zuerst: der Text, der Absender
  und die Uhrzeit, der Schweregrad als farbiges Abzeichen; tippe auf eine
  Meldung, um sie ganz zu lesen;
- eine Schaltfläche **Leeren**: Einmal gelesen, zeigt die Liste nur noch neue
  Meldungen.

Einstellungen: die Absender (leer: alle), der minimale angezeigte Schweregrad
(standardmäßig Fehler) und Schalter, um den Zähler und die Schaltfläche Leeren
auszublenden. Die schweren Meldungen liegen nur im Speicher: Ein Neustart der
Integration leert die Liste.

## Szenen

### Auslöser

- **Eine Regel trifft zu**: Eine Meldung trifft auf eine Regel zu. Filter: die
  Regeln, die Absender. Variablen: Name der Regel, Absender, IP-Adresse,
  Schweregrad, Programm, Meldung.
- **Eine schwere Meldung kommt an**: Ein Absender protokolliert eine Warnung
  oder Schlimmeres. Filter: die Schweregrade, die Absender. Dieselben
  Variablen, ohne die Regel.
- **Ein neuer Absender erscheint**: Ein nie gesehenes Gerät schickt seine erste
  Meldung (ein neues Gerät im Netzwerk oder ein falsch eingestelltes).
  Variablen: Absender, IP-Adresse.

Gegen Lawinen löst ein Auslöser höchstens alle 10 Sekunden für dieselbe Regel
und denselben Absender aus (oder denselben Absender und Schweregrad), und die
Integration schickt höchstens 120 Szenenereignisse pro Minute.

### Szenenideen

- „Stromausfall“: Regel `on battery` → eine Nachricht schicken und abschalten,
  was geht.
- „Jemand hat sich mit dem VPN verbunden“: Regel `Peer Connection Initiated` →
  eine Benachrichtigung mit `{{triggerEvent.data.message}}`.
- „Das NAS meldet einen Festplattenfehler“: der Auslöser „Eine schwere Meldung
  kommt an“, Schweregrade Kritisch und Fehler, Absender das NAS.

## Fehlerbehebung

- **Kein Gerät erscheint**: Prüfe, ob das Gerät an den richtigen Port sendet
  (den des Konfigurationsbildschirms, nicht 514) und an die IP-Adresse des
  Gladys-Rechners; teste mit `logger` von einem Computer. Prüfe die erlaubten
  Absender.
- **Der Konfigurationsbildschirm zeigt `{{port:syslog_udp}}`**: Der Empfänger
  ist noch nicht gestartet; lade die Seite einige Sekunden nach der
  Installation neu.
- **Alle Geräte haben dieselbe Adresse**: Diese gehen über ein Relay, oder Gladys
  betreibt Docker mit einer Netzwerkeinstellung, die die Adresse des Absenders
  verbirgt. Nutze die vertrauenswürdigen Relays.
- **Meldungen fehlen**: Ein Absender über seiner Grenze wird in den
  Protokollen der Integration gemeldet; erhöhe „Meldungen pro Sekunde je
  Absender“. UDP kann in einem ausgelasteten Netzwerk Meldungen verlieren: Nimm
  TCP.
- **Der Status ist rot**: Der Empfänger-Container läuft nicht (die Integration
  startet ihn selbst neu), ein regulärer Ausdruck einer Regel ist ungültig,
  oder ein erlaubter Absender wird nicht verstanden: Die Meldung sagt welcher.

## Grenzen

- Die Uhrzeit einer Meldung ist die ihres Empfangs: Geräteuhren gehen oft
  falsch, und das alte Syslog-Format hat weder Jahr noch Zeitzone.
- Ein Gerät wird an seiner IP-Adresse erkannt: Ein Gerät, dessen Adresse sich
  ändert, erscheint erneut in „Entdecken“.
- Kein TLS (Syslog über TLS, Port 6514): Der Empfänger ist für das lokale
  Netzwerk gedacht.
- Höchstens 200 Absender; Meldungen werden bei 2.048 Zeichen abgeschnitten.
- Nichts wird archiviert: Um in alten Protokollen zu suchen, nutze einen
  Protokollserver (Graylog…).
- Keine Verbindung zu einer der genannten Marken.
