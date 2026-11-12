# hassemu — beliebige Webseiten auf Displays, die nur Home Assistant akzeptieren

Manche Wanddisplays sprechen ausschließlich mit einem Home-Assistant-Server. Sie durchlaufen
die HA-Einrichtung und zeigen danach ein HA-Dashboard — und sonst nichts. hassemu beantwortet
genau die Teile des HA-Protokolls, nach denen diese Displays fragen. Die Einrichtung geht
dadurch durch, und anschließend schickt der Adapter das Display auf die Webseite deiner Wahl:
eine VIS-Ansicht, ein Aura-Dashboard, Grafana, Node-RED, eine selbstgebaute Seite.

Der Adapter ist **keine** Home-Assistant-Anbindung. Es wird nichts aus HA importiert, und
keine ioBroker-Datenpunkte werden als HA-Geräte angeboten. Der Adapter stellt nur so viel
HA-Server dar, dass das Display ihn akzeptiert — und hält sich danach heraus.

Diese Seite ist die ausführliche Anleitung. Die [README](../../README.md) ist die Kurzfassung.

## Voraussetzungen

- Node.js 22 oder neuer
- ioBroker js-controller 7.2.5 oder neuer
- ioBroker Admin 8.3.5 oder neuer
- Display und ioBroker im selben Netz

Der Adapter lauscht in der Vorgabe auf Port 8123, dem Port von Home Assistant; die
Home-Assistant-Apps nehmen den Port aus der Adresse, die der Server im Netz ansagt oder die man
eintippt. Ein anderer Port erlaubt hassemu auf einem Rechner, auf dem 8123 schon belegt ist, und
eine zweite Instanz auf demselben Rechner braucht einen eigenen Port oder eine eigene
Schnittstelle. Mehrere ioBroker-Rechner im Netz dürfen je eine betreiben; die Displays sehen
dann getrennte Server.

## Shelly Wall Display

Die Shelly-Wall-Display-Familie gibt es als ältere Modelle (Stargate, X2) und als neuere (XL,
X2i, X1i, U1, D1). Ein Display erreicht hassemu auf einem von zwei Wegen:

- **über die eingebaute Home-Assistant-Seite** — der ursprüngliche Weg; Firmware 2.7.0 hat
  sie nicht mehr als veraltet markiert
- **über die Home-Assistant-App auf dem Gerät** ab Firmware 2.6.0 — sie durchläuft dieselbe
  Einrichtung wie die Companion-App auf einem Handy

hassemu bedient beide. Firmware 2.7.0 hat außerdem _WebView-Cache leeren_ gebracht
(Einstellungen → Home Assistant). Das löscht das Erkennungsmerkmal des Displays: Danach
erscheint es einmal unter einer neuen Kennung und durchläuft die Einrichtung erneut. Den alten
Eintrag über seinen `remove`-Knopf entfernen.

## Einrichtung

### 1. Instanz anlegen

Adapter installieren, Instanz 0 starten. In den Instanz-Einstellungen musst du zunächst
nichts ändern: mDNS ist an, die Anmeldung ist aus, und der Adapter lauscht auf allen
Schnittstellen.

Hat dein ioBroker-Rechner mehrere Netzwerkkarten, stell **Interface binden** auf die,
in der deine Displays hängen. Der Adapter kündigt sich unter dieser Adresse an — kündigt er
eine an, die das Display nicht erreicht, ist das der häufigste Grund dafür, dass die
Erkennung scheinbar klappt, die Verbindung danach aber nicht.

### 2. Server am Display eintragen

Am Display einen Home-Assistant-Server hinzufügen.

- **Mit mDNS** findet das Display den Server von allein. Er erscheint unter dem Namen aus
  **Service-Name** (Vorgabe `ioBroker`).
- **Ohne mDNS** — oder wenn das Display nicht sucht — die Adresse von Hand eintragen:
  `http://<IP-deines-ioBroker>:8123` (mit anderem Port dieser Port). Mit HTTPS ist es
  `https://<Name im Zertifikat>:8123`, siehe [Anmeldung und dein Netz](#anmeldung-und-dein-netz).

**Android 17 und neuer:** Erlaube der Home-Assistant-App den _Zugriff auf das lokale Netzwerk_,
wenn sie danach fragt. Ohne ihn findet die App hassemu nicht und erreicht es in deinem Netz
auch nicht — hassemu läuft nur im Heimnetz, einen Umweg über eine Cloud gibt es nicht.

### 3. Einrichtung abschließen

Das Display durchläuft jetzt die HA-Anmeldung. Ist die Anmeldung aus, klickst du einfach
durch. Ist sie an, gibst du Benutzernamen und Passwort aus den Instanz-Einstellungen ein.

Hinter diesem Klick tauschen Display und Adapter ein Zugangsmerkmal aus, und der Adapter
hinterlegt ein Erkennungsmerkmal (Cookie) auf dem Display. Das ist von da an die Identität
des Displays: Es übersteht Neustarts, Adresswechsel und Namensänderungen — deshalb behält ein
Display seine Seite, ohne neu eingerichtet zu werden.

### 4. Das Display wartet jetzt

Ist die Einrichtung durch, zeigt das Display eine kleine Seite mit einer Geräte-Kennung.
Diese Seite bedeutet: verbunden, aber noch keine Seite gewählt. Über die Kennung findest du
das Display im Objektbaum wieder.

### 5. Dem Display sagen, was es zeigen soll

Im ioBroker-Objektbaum das Display unter `hassemu.0.clients.<Kennung>` öffnen und **mode**
setzen:

- eines der gefundenen Dashboards aus der Auswahlliste nehmen, oder
- `Manuelle URL` wählen und die Adresse daneben in **manualUrl** eintragen.

Das Display lädt innerhalb von etwa 30 Sekunden neu.

Sollen alle Displays dieselbe Seite zeigen, nimm `hassemu.0.global.mode` (und
`global.manualUrl`) und schalte `global.enabled` ein, statt jedes Display einzeln zu setzen.

## Was ein Display anzeigt

Jedes Display trägt seinen eigenen **mode**. Der Adapter löst ihn bei jeder Anfrage auf:

| mode               | Was das Display bekommt                  |
| ------------------ | ---------------------------------------- |
| eine URL           | diese Seite                              |
| `Manuelle URL`     | was in `manualUrl` dieses Displays steht |
| `Globale URL`      | worauf `global.mode` hinausläuft         |
| `---` (keine Wahl) | die Warteseite mit der Geräte-Kennung    |

`global.mode` wird genauso aufgelöst, nur darf er selbst nicht `Globale URL` sein — das
zeigte auf sich selbst, und der Adapter weist den Schreibvorgang ab.

### Der Hauptschalter

`global.enabled` ist kein Zustand, in dem ein Display sein kann, sondern eine Sammelaktion
über alle:

- **Einschalten** setzt jedes Display auf `Globale URL`.
- **Ausschalten** setzt jedes Display zurück auf `---`.

Ausschalten stellt also **nicht** wieder her, was die Displays vorher hatten — es leert sie
alle. Danach die gewünschten Displays einzeln setzen. Neue Displays starten immer auf `---`,
nie auf einer Seite, die du für sie nicht ausgewählt hast.

## Was im Objektbaum liegt

```
hassemu.0.
├── info.
│   ├── connection      der Adapter läuft
│   ├── serverUuid      die Identität, an der die Displays den Server wiedererkennen
│   └── refreshUrls     Knopf: erneut nach Dashboards suchen
├── global.
│   ├── enabled         Hauptschalter (siehe oben)
│   ├── mode            die Seite für alle Displays, die auf Globale URL stehen
│   └── manualUrl       freie Adresse, genutzt wenn global.mode auf Manuelle URL steht
└── clients.
    └── <Kennung>       ein Eintrag je Display, benannt nach dem Gerätenamen der App, dem Hostnamen oder der Adresse
        ├── mode        was dieses Display zeigt
        ├── manualUrl   freie Adresse, genutzt wenn mode auf Manuelle URL steht
        ├── resolvedUrl die Adresse, an die dieses Display tatsächlich geschickt wurde
        ├── ip          die Adresse, unter der das Display zuletzt gesehen wurde
        └── remove      Knopf: dieses Display vergessen
```

**serverUuid** ist gut zu kennen: Daran erkennen die Displays den Server wieder. Sie wird
einmal erzeugt und behalten, damit ein Adapter-Neustart für das Display nicht wie ein anderer
Server aussieht. Änderte sie sich, wollte sich jedes Display neu einrichten.

**remove** löscht den Eintrag und damit die Identität des Displays. Verbindet es sich das
nächste Mal, ist es ein neues und startet auf `---`. Gedacht für Displays, die du abgebaut
hast; Einträge, die 30 Tage nicht gesehen wurden, räumt der Adapter ohnehin selbst weg.

**resolvedUrl** beantwortet die Frage „wo ist dieses Display tatsächlich gelandet". Der Wert
ist nur lesbar und folgt jeder Änderung: Wählst du ein Dashboard, steht dessen Adresse drin;
steht das Display auf Globale URL, das Ergebnis der globalen Einstellung; nimmst du die Auswahl
zurück, ist er leer, weil das Display seine Startseite zeigt. Praktisch bei Displays auf Globale
URL — sonst müsstest du dich für das Ergebnis durch zwei Einstellungen arbeiten.

**ip** ist nur zur Information. Displays werden über ihr Erkennungsmerkmal identifiziert,
nicht über die Adresse — eine neue Adresse vom Router legt also keinen zweiten Eintrag an.

## Die drei Seiten des Adapters

Neben deinem Dashboard kann das Display drei Seiten zeigen, die vom Adapter selbst kommen.

**Die Warteseite** — Geräte-Kennung und ein Hinweis. Bedeutet: verbunden, keine Seite
gewählt. Sie lädt sich alle 15 Sekunden selbst neu und verschwindet damit von allein, sobald
du einen Modus setzt.

**„hassemu offline"** — der Adapter ist gestoppt oder nicht erreichbar. Das Display merkt es
nach etwa 1,5 Minuten, bietet einen Knopf zum Neuladen und kehrt von selbst zu deinem
Dashboard zurück, sobald der Adapter wieder da ist. Eine Einschränkung: Ein Display, das
startet, _während_ der Adapter aus ist, kann diese Seite nicht laden und zeigt stattdessen
seinen eigenen Verbindungsfehler.

**„Weiterleitungsziel nicht erreichbar"** — der Adapter läuft, aber die Seite, auf die er das
Display schickt, antwortet nicht. Ohne diese Karte sähst du nur Schwarz. Sie nennt die
Zieladresse und bietet Neuladen an; das Display kehrt von selbst zum Dashboard zurück, sobald
das Ziel wieder antwortet.

Der Adapter urteilt dabei zurückhaltend: **Jede** HTTP-Antwort zählt als erreichbar, auch
eine Anmeldeseite oder eine Fehlerseite — dort läuft ja ein Server. Nur eine abgelehnte
Verbindung oder eine Zeitüberschreitung lässt die Karte erscheinen. Zertifikate prüft er
nicht, denn bei einem Dashboard zu Hause sind selbstsignierte Zertifikate der Normalfall.

## Woher die Auswahlliste kommt

Der Adapter durchsucht den ioBroker-Rechner nach Seiten, die sich anzubieten lohnen:

- **VIS und VIS-2** — ein Eintrag je Projekt und einer je Ansicht darin, für jede vorhandene
  `web`-Instanz
- **Aura** — ein Eintrag je laufender Instanz, mit dem Port, auf den diese Instanz
  tatsächlich eingestellt ist; ein Aura, das eine `web`-Instanz ausliefert, zeigt dorthin,
  und ein Aura, das nur auf dem eigenen Rechner lauscht, bekommt keinen Eintrag, weil kein
  Display es erreichen könnte
- **Admin-Kacheln** — die Kacheln, die die ioBroker-Startseite zeigt: die Geräte-Seite,
  Grafana, jarvis, material, deine eigene Web-Oberfläche und die Link-Karten, die du auf der
  Startseite angelegt hast. Eine Kachel, die du auf der Startseite ausgeblendet hast, bleibt
  aus der Liste, und zwei Kacheln mit derselben Adresse sind ein Eintrag

Gesucht wird beim Start und immer dann, wenn eine Adapter-Instanz dazukommt, verschwindet
oder umkonfiguriert wird oder sich die Einstellungen der Startseite ändern. Ein Display
behält seine Seite, auch wenn sie aus der Liste fällt. Nach dem Anlegen oder Umbenennen eines VIS-2-Projekts oder einer
Ansicht setzt du **info.refreshUrls** auf `true`, um ohne Adapter-Neustart neu zu suchen.

Wird etwas nicht gefunden, ist es nicht verloren: `Manuelle URL` wählen und die Adresse
einsetzen. Adressen mit `javascript:`, `data:` oder `file:` weist der Adapter ab — das sind
keine Seiten, das ist Programmcode.

## Anmeldung und dein Netz

**Reines HTTP ist die Vorgabe**, wie bei Home Assistant, und ohne HTTPS läuft alles auf dem
Port unverschlüsselt. Daraus folgen zwei Dinge, die man klar sagen sollte:

- Behandle den Port als etwas, das nur in dein Heimnetz gehört. Leite ihn nicht aus dem
  Internet herein.
- Ist die Anmeldung an, laufen Benutzername, Passwort und Zugangsmerkmale unverschlüsselt
  durch dein Netz. Die Anmeldung hält andere Geräte in deinem Netz von der HA-Schnittstelle
  fern — sie ist kein Schutz gegen eine Öffnung ins Internet.

**HTTPS verwenden** in den Instanz-Einstellungen verschlüsselt Anmeldung, Passwort und Tokens
mit einem Zertifikat aus ioBroker. HTTPS hat eigene Regeln:

- Mit HTTPS erreichen die Displays hassemu unter dem Namen im Zertifikat statt unter der IP-Adresse — dieser Name muss auf jedem Display auflösbar sein.
- Mit dem Standard-Zertifikat von ioBroker (selbst ausgestellt, auf den Rechnernamen) braucht ein Android-Display beides: das Zertifikat als vertrauenswürdig installiert und ein Netz, das den Rechnernamen auflöst.
- Ein Dashboard über reines HTTP lässt sich in einer HTTPS-Seite nicht anzeigen — wähle dafür eine HTTPS-Adresse.
- Das Einschalten ändert die Adresse von hassemu: Jedes Display erscheint einmal als neues Gerät und muss auf die neue Adresse eingestellt werden.

**Reverse-Proxy-Header vertrauen** bleibt aus, solange nicht wirklich ein Reverse-Proxy
davor steht, der die Verschlüsselung beendet und die vom Client mitgeschickten
`X-Forwarded-*`-Header entfernt. Ohne einen solchen eingeschaltet, kann jedes Gerät bei
**jeder einzelnen Anfrage** eine andere Adresse behaupten. Der Adapter protokolliert dann
falsche Adressen, und seine Grenze für neue Display-Einträge je Adresse begrenzt nichts mehr.
Seit Version 1.40.0 gibt es deshalb eine zweite Grenze, die nicht an der Adresse hängt —
höchstens 100 neue Display-Einträge pro Stunde insgesamt. Eine Fehlkonfiguration kann die
Datenbank damit nicht mehr vollschreiben. Displays funktionieren weiter, solange diese Grenze
greift; sie bekommen nur keine gespeicherte Identität, bis der Schwall vorbei ist. Die Grenze
deckelt den Schaden — sie macht die Einstellung nicht sicher.

## Ports

| Port       | Richtung  | Wofür der Adapter ihn braucht                                            |
| ---------- | --------- | ------------------------------------------------------------------------ |
| 8123 / TCP | eingehend | die HA-Schnittstelle, mit der das Display spricht (Vorgabe, einstellbar) |
| 5353 / UDP | eingehend | mDNS, damit Displays den Server von allein finden                        |

Für Uptime-Monitore und Container-Healthchecks `http://<IP-deines-ioBroker>:8123/health`
nehmen (mit HTTPS `https://`, mit anderem Port dieser Port). Diese Adresse antwortet, ohne etwas anzulegen. Ein `GET /` ist das, was ein Display
bei seinem ersten Besuch schickt — ein Monitor dort erschiene als neues Display; ein `HEAD /`
legt nichts an.

## Umstieg von 1.x

Version 2.0.0 gibt jedem Display einmal eine neue Objekt-ID: aus `clients.61c3a1` wird
`clients.display-c3a1` — `display` und die letzten vier Zeichen der alten ID. Der Umzug passiert
beim ersten Start von selbst: Werte, Räume, Funktionen und Aliase ziehen mit, aufgezeichnete
Verläufe laufen in ihrer bisherigen Reihe weiter, und das Display wird weiter erkannt, nichts muss
neu eingerichtet werden. Das Log nennt jeden Umzug. Skripte und Visualisierungen mit den alten IDs
müssen angepasst werden. Danach nicht auf 1.x zurückgehen.

Ein Display, das sich zum ersten Mal verbindet, bekommt das Modell, das seine Home-Assistant-App
meldet, und vier Zeichen, die hassemu selbst wählt, zum Beispiel `clients.pixel-tablet-02b7`;
meldet das Display kein Modell, beginnt die ID mit `display`. Eine vergebene ID ändert sich nie.

Jedes Display heißt nach dem Gerätenamen seiner App, seinem Hostnamen oder seiner Adresse; ein im
Objektbaum eingetippter Name weicht dem. Ein Display, das nach seinem Hostnamen hieß, zeigt bis zu
seiner ersten Verbindung nach dem Update seine Adresse.

## Häufige Fragen

**Kann ich zwei Instanzen betreiben?** Ja, auf einem Rechner jede mit eigenem Port oder
eigener Schnittstelle. Zwei ioBroker-Rechner dürfen je eine betreiben; die Displays sehen dann
zwei getrennte Server.

**Muss das Display dauerhaft mit dem Adapter verbunden bleiben?** Ja. Es holt seine Seite
über den Adapter, und die Offline-Seite wie auch die Ziel-Prüfung hängen daran. Stoppt der
Adapter, bleibt das Dashboard noch etwa 1,5 Minuten stehen; dann zeigt das Display die
Offline-Seite und kehrt von selbst zum Dashboard zurück, sobald der Adapter wieder da ist.

**Kann ich ein Display umbenennen?** Der Name kommt vom Display selbst: der Gerätename aus
seiner Home-Assistant-App, sonst sein Hostname im Netzwerk, sonst seine Adresse. Zum Ändern das
Gerät in der App umbenennen oder ihm im Router einen Hostnamen geben. Ein im Objektbaum
eingetippter Name hält nicht — der Adapter schreibt beim nächsten Start oder bei der nächsten
Änderung den Namen des Displays zurück.

**Warum gibt es zwei Einträge für dasselbe Display?** Das Display hat sein Erkennungsmerkmal
nicht zurückgeschickt — meist nach einem Zurücksetzen auf Werkseinstellungen, einem geleerten
Browser- oder WebView-Speicher (Shelly ab Firmware 2.7.0: Einstellungen → Home Assistant)
oder in einem Privatmodus, der Cookies verwirft. Den alten Eintrag über
seinen `remove`-Knopf entfernen. Die Ursache liegt am Display, nicht am Adapter.

**Brauche ich ein installiertes Home Assistant?** Nein. Der Adapter beantwortet das
HA-Protokoll selbst. In diesem Aufbau gibt es nirgends ein Home Assistant.

**Kann das Display ioBroker steuern?** Nein. Über die Verbindung laufen die Einrichtung und
die Seitenadresse, sonst nichts. Es werden keine Datenpunkte angeboten und keine Befehle
angenommen.

## Herausfinden, was schiefgelaufen ist

Stell die Protokollstufe der Instanz auf `debug`. Der Adapter schreibt dann jede Entscheidung
mit: welches Display erkannt wurde, wie die Anmeldung lief, welche Dashboards gefunden
wurden, und wie er den Modus je Anfrage zu einer Adresse aufgelöst hat. Die meisten Probleme
lassen sich direkt aus diesem Protokoll ablesen.

Ist mDNS an, im Protokoll steht aber keine Zeile `mDNS: Broadcasting`, ging die Ankündigung
nicht raus — meist, weil etwas anderes Port 5353 belegt. Dann mDNS ausschalten und die
Adresse am Display von Hand eintragen; alles Übrige bleibt gleich.

Findet die Home-Assistant-App unter Android 17 oder neuer nichts und verbindet sich auch mit
von Hand eingetragener Adresse nicht, fehlt ihr der _Zugriff auf das lokale Netzwerk_ — in den
App-Einstellungen erlauben.
