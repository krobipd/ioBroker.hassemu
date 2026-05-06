"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var i18n_logs_exports = {};
__export(i18n_logs_exports, {
  LOG_STRINGS: () => LOG_STRINGS,
  tLog: () => tLog
});
module.exports = __toCommonJS(i18n_logs_exports);
const SUPPORTED_LANGS = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];
function fmt(template, params) {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const v = params[key];
    if (v === null) {
      return "(none)";
    }
    if (v === void 0) {
      return `{${key}}`;
    }
    return String(v);
  });
}
const LOG_STRINGS = {
  serverStarted: {
    en: "HA emulation running on {bindAddr}:{port}{mdnsSuffix}",
    de: "HA-Emulation l\xE4uft auf {bindAddr}:{port}{mdnsSuffix}",
    ru: "HA-\u044D\u043C\u0443\u043B\u044F\u0446\u0438\u044F \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u0430 \u043D\u0430 {bindAddr}:{port}{mdnsSuffix}",
    pt: "Emula\xE7\xE3o HA em execu\xE7\xE3o em {bindAddr}:{port}{mdnsSuffix}",
    nl: "HA-emulatie draait op {bindAddr}:{port}{mdnsSuffix}",
    fr: "\xC9mulation HA active sur {bindAddr}:{port}{mdnsSuffix}",
    it: "Emulazione HA in esecuzione su {bindAddr}:{port}{mdnsSuffix}",
    es: "Emulaci\xF3n HA en marcha en {bindAddr}:{port}{mdnsSuffix}",
    pl: "Emulacja HA dzia\u0142a na {bindAddr}:{port}{mdnsSuffix}",
    uk: "HA-\u0435\u043C\u0443\u043B\u044F\u0446\u0456\u044F \u043F\u0440\u0430\u0446\u044E\u0454 \u043D\u0430 {bindAddr}:{port}{mdnsSuffix}",
    "zh-cn": "HA \u6A21\u62DF\u8FD0\u884C\u4E8E {bindAddr}:{port}{mdnsSuffix}"
  },
  serverUuidGenerated: {
    en: "Server UUID generated and saved: {uuid}",
    de: "Server-UUID erzeugt und gespeichert: {uuid}",
    ru: "UUID \u0441\u0435\u0440\u0432\u0435\u0440\u0430 \u0441\u043E\u0437\u0434\u0430\u043D \u0438 \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D: {uuid}",
    pt: "UUID do servidor gerado e guardado: {uuid}",
    nl: "Server-UUID gegenereerd en opgeslagen: {uuid}",
    fr: "UUID du serveur g\xE9n\xE9r\xE9 et sauvegard\xE9 : {uuid}",
    it: "UUID server generato e salvato: {uuid}",
    es: "UUID del servidor generado y guardado: {uuid}",
    pl: "UUID serwera wygenerowany i zapisany: {uuid}",
    uk: "UUID \u0441\u0435\u0440\u0432\u0435\u0440\u0430 \u0437\u0433\u0435\u043D\u0435\u0440\u043E\u0432\u0430\u043D\u043E \u0442\u0430 \u0437\u0431\u0435\u0440\u0435\u0436\u0435\u043D\u043E: {uuid}",
    "zh-cn": "\u5DF2\u751F\u6210\u5E76\u4FDD\u5B58\u670D\u52A1\u5668 UUID: {uuid}"
  },
  serverUuidPersistFailed: {
    en: "Could not save server UUID: {error}",
    de: "Server-UUID konnte nicht gespeichert werden: {error}",
    ru: "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C UUID \u0441\u0435\u0440\u0432\u0435\u0440\u0430: {error}",
    pt: "N\xE3o foi poss\xEDvel guardar o UUID do servidor: {error}",
    nl: "Server-UUID kon niet worden opgeslagen: {error}",
    fr: "Impossible d'enregistrer l'UUID du serveur : {error}",
    it: "Impossibile salvare l'UUID del server: {error}",
    es: "No se pudo guardar el UUID del servidor: {error}",
    pl: "Nie mo\u017Cna zapisa\u0107 UUID serwera: {error}",
    uk: "\u041D\u0435 \u0432\u0434\u0430\u043B\u043E\u0441\u044F \u0437\u0431\u0435\u0440\u0435\u0433\u0442\u0438 UUID \u0441\u0435\u0440\u0432\u0435\u0440\u0430: {error}",
    "zh-cn": "\u65E0\u6CD5\u4FDD\u5B58\u670D\u52A1\u5668 UUID: {error}"
  },
  webServerFailedToStart: {
    en: "Web server failed to start: {error}",
    de: "Web-Server konnte nicht gestartet werden: {error}",
    ru: "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C \u0432\u0435\u0431-\u0441\u0435\u0440\u0432\u0435\u0440: {error}",
    pt: "Falha ao iniciar o servidor web: {error}",
    nl: "Webserver kon niet worden gestart: {error}",
    fr: "Impossible de d\xE9marrer le serveur web : {error}",
    it: "Impossibile avviare il server web: {error}",
    es: "No se pudo iniciar el servidor web: {error}",
    pl: "Nie mo\u017Cna uruchomi\u0107 serwera WWW: {error}",
    uk: "\u041D\u0435 \u0432\u0434\u0430\u043B\u043E\u0441\u044F \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0438 \u0432\u0435\u0431-\u0441\u0435\u0440\u0432\u0435\u0440: {error}",
    "zh-cn": "Web \u670D\u52A1\u5668\u542F\u52A8\u5931\u8D25: {error}"
  },
  mdnsDisabledHint: {
    en: "mDNS is disabled \u2014 displays must be pointed at http://{ip}:{port} manually",
    de: "mDNS ist deaktiviert \u2014 Displays m\xFCssen manuell auf http://{ip}:{port} gestellt werden",
    ru: "mDNS \u043E\u0442\u043A\u043B\u044E\u0447\u0451\u043D \u2014 \u043D\u0430\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0430 \u043D\u0430 http://{ip}:{port} \u0432\u0440\u0443\u0447\u043D\u0443\u044E",
    pt: "mDNS desativado \u2014 aponte os ecr\xE3s manualmente para http://{ip}:{port}",
    nl: "mDNS is uitgeschakeld \u2014 wijs schermen handmatig naar http://{ip}:{port}",
    fr: "mDNS d\xE9sactiv\xE9 \u2014 pointez les \xE9crans manuellement vers http://{ip}:{port}",
    it: "mDNS disabilitato \u2014 puntare i display manualmente a http://{ip}:{port}",
    es: "mDNS desactivado \u2014 apunta las pantallas manualmente a http://{ip}:{port}",
    pl: "mDNS wy\u0142\u0105czony \u2014 skieruj ekrany r\u0119cznie na http://{ip}:{port}",
    uk: "mDNS \u0432\u0438\u043C\u043A\u043D\u0435\u043D\u043E \u2014 \u0441\u043F\u0440\u044F\u043C\u0443\u0439\u0442\u0435 \u0435\u043A\u0440\u0430\u043D\u0438 \u0432\u0440\u0443\u0447\u043D\u0443 \u043D\u0430 http://{ip}:{port}",
    "zh-cn": "mDNS \u5DF2\u7981\u7528 \u2014 \u8BF7\u624B\u52A8\u5C06\u663E\u793A\u5668\u6307\u5411 http://{ip}:{port}"
  },
  migrationStarted: {
    en: "Migrating legacy URL configuration to the new model",
    de: "Alte URL-Konfiguration wird auf das neue Modell migriert",
    ru: "\u041C\u0438\u0433\u0440\u0430\u0446\u0438\u044F \u0443\u0441\u0442\u0430\u0440\u0435\u0432\u0448\u0435\u0439 \u043A\u043E\u043D\u0444\u0438\u0433\u0443\u0440\u0430\u0446\u0438\u0438 URL \u043D\u0430 \u043D\u043E\u0432\u0443\u044E \u043C\u043E\u0434\u0435\u043B\u044C",
    pt: "A migrar configura\xE7\xE3o URL legada para o novo modelo",
    nl: "Oude URL-configuratie wordt gemigreerd naar het nieuwe model",
    fr: "Migration de l'ancienne configuration URL vers le nouveau mod\xE8le",
    it: "Migrazione della vecchia configurazione URL al nuovo modello",
    es: "Migrando configuraci\xF3n URL antigua al nuevo modelo",
    pl: "Migracja starej konfiguracji URL do nowego modelu",
    uk: "\u041C\u0456\u0433\u0440\u0430\u0446\u0456\u044F \u0441\u0442\u0430\u0440\u043E\u0457 \u043A\u043E\u043D\u0444\u0456\u0433\u0443\u0440\u0430\u0446\u0456\u0457 URL \u043D\u0430 \u043D\u043E\u0432\u0443 \u043C\u043E\u0434\u0435\u043B\u044C",
    "zh-cn": "\u6B63\u5728\u5C06\u65E7\u7684 URL \u914D\u7F6E\u8FC1\u79FB\u5230\u65B0\u6A21\u578B"
  },
  migrationGlobalUrlSucceeded: {
    en: 'Migration: global URL "{url}" moved to global.manualUrl',
    de: 'Migration: globale URL "{url}" wurde nach global.manualUrl \xFCbernommen',
    ru: '\u041C\u0438\u0433\u0440\u0430\u0446\u0438\u044F: \u0433\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u044B\u0439 URL "{url}" \u043F\u0435\u0440\u0435\u043D\u0435\u0441\u0451\u043D \u0432 global.manualUrl',
    pt: 'Migra\xE7\xE3o: URL global "{url}" movido para global.manualUrl',
    nl: 'Migratie: globale URL "{url}" verplaatst naar global.manualUrl',
    fr: "Migration : URL globale \xAB {url} \xBB d\xE9plac\xE9e vers global.manualUrl",
    it: 'Migrazione: URL globale "{url}" spostato in global.manualUrl',
    es: 'Migraci\xF3n: URL global "{url}" movida a global.manualUrl',
    pl: 'Migracja: globalny URL \u201E{url}" przeniesiony do global.manualUrl',
    uk: "\u041C\u0456\u0433\u0440\u0430\u0446\u0456\u044F: \u0433\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u0438\u0439 URL \xAB{url}\xBB \u043F\u0435\u0440\u0435\u043D\u0435\u0441\u0435\u043D\u043E \u0434\u043E global.manualUrl",
    "zh-cn": '\u8FC1\u79FB\uFF1A\u5168\u5C40 URL "{url}" \u5DF2\u79FB\u81F3 global.manualUrl'
  },
  migrationGlobalUrlRejected: {
    en: "Migration: legacy global URL rejected as unsafe \u2014 please set global.manualUrl manually",
    de: "Migration: alte globale URL als unsicher abgelehnt \u2014 bitte global.manualUrl manuell setzen",
    ru: "\u041C\u0438\u0433\u0440\u0430\u0446\u0438\u044F: \u0443\u0441\u0442\u0430\u0440\u0435\u0432\u0448\u0438\u0439 \u0433\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u044B\u0439 URL \u043E\u0442\u043A\u043B\u043E\u043D\u0451\u043D \u043A\u0430\u043A \u043D\u0435\u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u044B\u0439 \u2014 \u0437\u0430\u0434\u0430\u0439\u0442\u0435 global.manualUrl \u0432\u0440\u0443\u0447\u043D\u0443\u044E",
    pt: "Migra\xE7\xE3o: URL global legado rejeitado como inseguro \u2014 defina global.manualUrl manualmente",
    nl: "Migratie: oude globale URL afgewezen als onveilig \u2014 stel global.manualUrl handmatig in",
    fr: "Migration : ancienne URL globale rejet\xE9e comme non s\xFBre \u2014 d\xE9finissez global.manualUrl manuellement",
    it: "Migrazione: vecchio URL globale rifiutato perch\xE9 non sicuro \u2014 impostare global.manualUrl manualmente",
    es: "Migraci\xF3n: URL global antigua rechazada por insegura \u2014 establezca global.manualUrl manualmente",
    pl: "Migracja: stary globalny URL odrzucony jako niebezpieczny \u2014 ustaw global.manualUrl r\u0119cznie",
    uk: "\u041C\u0456\u0433\u0440\u0430\u0446\u0456\u044F: \u0441\u0442\u0430\u0440\u0438\u0439 \u0433\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u0438\u0439 URL \u0432\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E \u044F\u043A \u043D\u0435\u0431\u0435\u0437\u043F\u0435\u0447\u043D\u0438\u0439 \u2014 \u0437\u0430\u0434\u0430\u0439\u0442\u0435 global.manualUrl \u0432\u0440\u0443\u0447\u043D\u0443",
    "zh-cn": "\u8FC1\u79FB\uFF1A\u65E7\u7684\u5168\u5C40 URL \u88AB\u5224\u5B9A\u4E3A\u4E0D\u5B89\u5168\u5DF2\u62D2\u7EDD \u2014 \u8BF7\u624B\u52A8\u8BBE\u7F6E global.manualUrl"
  },
  migrationLegacyUrlPreserved: {
    en: "Legacy URL preserved in instance config \u2014 neither global URL write succeeded",
    de: "Alte URL bleibt in der Instance-Config \u2014 keiner der globalen URL-Writes war erfolgreich",
    ru: "\u0423\u0441\u0442\u0430\u0440\u0435\u0432\u0448\u0438\u0439 URL \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D \u0432 \u043A\u043E\u043D\u0444\u0438\u0433\u0443\u0440\u0430\u0446\u0438\u0438 \u044D\u043A\u0437\u0435\u043C\u043F\u043B\u044F\u0440\u0430 \u2014 \u043D\u0438 \u043E\u0434\u043D\u0430 \u0437\u0430\u043F\u0438\u0441\u044C \u0433\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u043E\u0433\u043E URL \u043D\u0435 \u043F\u0440\u043E\u0448\u043B\u0430",
    pt: "URL legado mantido na configura\xE7\xE3o da inst\xE2ncia \u2014 nenhuma escrita de URL global teve sucesso",
    nl: "Oude URL behouden in instance-config \u2014 geen globale URL-write is gelukt",
    fr: "Ancienne URL conserv\xE9e dans la config d'instance \u2014 aucune \xE9criture d'URL globale n'a r\xE9ussi",
    it: "URL legacy mantenuto nella config dell'istanza \u2014 nessuna scrittura URL globale riuscita",
    es: "URL antigua conservada en la config de la instancia \u2014 ninguna escritura de URL global tuvo \xE9xito",
    pl: "Stary URL zachowany w config instancji \u2014 \u017Caden zapis globalnego URL si\u0119 nie powi\xF3d\u0142",
    uk: "\u0421\u0442\u0430\u0440\u0438\u0439 URL \u0437\u0431\u0435\u0440\u0435\u0436\u0435\u043D\u043E \u0443 \u043A\u043E\u043D\u0444\u0456\u0433\u0443\u0440\u0430\u0446\u0456\u0457 \u0456\u043D\u0441\u0442\u0430\u043D\u0441\u0443 \u2014 \u0436\u043E\u0434\u0435\u043D \u0437\u0430\u043F\u0438\u0441 \u0433\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u043E\u0433\u043E URL \u043D\u0435 \u0432\u0434\u0430\u0432\u0441\u044F",
    "zh-cn": "\u65E7 URL \u4FDD\u7559\u5728\u5B9E\u4F8B\u914D\u7F6E\u4E2D \u2014 \u5168\u5C40 URL \u5199\u5165\u5747\u672A\u6210\u529F"
  },
  migrationClientUrlSucceeded: {
    en: 'Migration: client {id} URL "{url}" moved to manualUrl',
    de: 'Migration: URL "{url}" f\xFCr Client {id} wurde nach manualUrl \xFCbernommen',
    ru: '\u041C\u0438\u0433\u0440\u0430\u0446\u0438\u044F: URL "{url}" \u043A\u043B\u0438\u0435\u043D\u0442\u0430 {id} \u043F\u0435\u0440\u0435\u043D\u0435\u0441\u0451\u043D \u0432 manualUrl',
    pt: 'Migra\xE7\xE3o: URL "{url}" do cliente {id} movido para manualUrl',
    nl: 'Migratie: URL "{url}" voor client {id} verplaatst naar manualUrl',
    fr: "Migration : URL \xAB {url} \xBB du client {id} d\xE9plac\xE9e vers manualUrl",
    it: 'Migrazione: URL "{url}" del client {id} spostato in manualUrl',
    es: 'Migraci\xF3n: URL "{url}" del cliente {id} movida a manualUrl',
    pl: 'Migracja: URL \u201E{url}" klienta {id} przeniesiony do manualUrl',
    uk: "\u041C\u0456\u0433\u0440\u0430\u0446\u0456\u044F: URL \xAB{url}\xBB \u043A\u043B\u0456\u0454\u043D\u0442\u0430 {id} \u043F\u0435\u0440\u0435\u043D\u0435\u0441\u0435\u043D\u043E \u0434\u043E manualUrl",
    "zh-cn": '\u8FC1\u79FB\uFF1A\u5BA2\u6237\u7AEF {id} \u7684 URL "{url}" \u5DF2\u79FB\u81F3 manualUrl'
  },
  migrationClientUrlRejected: {
    en: "Migration: client {id} legacy URL rejected as unsafe \u2014 please set the URL manually",
    de: "Migration: alte URL f\xFCr Client {id} als unsicher abgelehnt \u2014 bitte URL manuell setzen",
    ru: "\u041C\u0438\u0433\u0440\u0430\u0446\u0438\u044F: \u0443\u0441\u0442\u0430\u0440\u0435\u0432\u0448\u0438\u0439 URL \u043A\u043B\u0438\u0435\u043D\u0442\u0430 {id} \u043E\u0442\u043A\u043B\u043E\u043D\u0451\u043D \u043A\u0430\u043A \u043D\u0435\u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u044B\u0439 \u2014 \u0437\u0430\u0434\u0430\u0439\u0442\u0435 URL \u0432\u0440\u0443\u0447\u043D\u0443\u044E",
    pt: "Migra\xE7\xE3o: URL legado do cliente {id} rejeitado como inseguro \u2014 defina o URL manualmente",
    nl: "Migratie: oude URL voor client {id} afgewezen als onveilig \u2014 stel URL handmatig in",
    fr: "Migration : ancienne URL du client {id} rejet\xE9e comme non s\xFBre \u2014 d\xE9finissez l\u2019URL manuellement",
    it: "Migrazione: vecchio URL del client {id} rifiutato perch\xE9 non sicuro \u2014 impostare l\u2019URL manualmente",
    es: "Migraci\xF3n: URL antigua del cliente {id} rechazada por insegura \u2014 establezca el URL manualmente",
    pl: "Migracja: stary URL klienta {id} odrzucony jako niebezpieczny \u2014 ustaw URL r\u0119cznie",
    uk: "\u041C\u0456\u0433\u0440\u0430\u0446\u0456\u044F: \u0441\u0442\u0430\u0440\u0438\u0439 URL \u043A\u043B\u0456\u0454\u043D\u0442\u0430 {id} \u0432\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E \u044F\u043A \u043D\u0435\u0431\u0435\u0437\u043F\u0435\u0447\u043D\u0438\u0439 \u2014 \u0437\u0430\u0434\u0430\u0439\u0442\u0435 URL \u0432\u0440\u0443\u0447\u043D\u0443",
    "zh-cn": "\u8FC1\u79FB\uFF1A\u5BA2\u6237\u7AEF {id} \u7684\u65E7 URL \u88AB\u5224\u5B9A\u4E3A\u4E0D\u5B89\u5168\u5DF2\u62D2\u7EDD \u2014 \u8BF7\u624B\u52A8\u8BBE\u7F6E URL"
  },
  legacyConfigCleanupFailed: {
    en: "Legacy config cleanup failed: {error}",
    de: "Aufr\xE4umen der alten Konfiguration fehlgeschlagen: {error}",
    ru: "\u041E\u0447\u0438\u0441\u0442\u043A\u0430 \u0443\u0441\u0442\u0430\u0440\u0435\u0432\u0448\u0435\u0439 \u043A\u043E\u043D\u0444\u0438\u0433\u0443\u0440\u0430\u0446\u0438\u0438 \u043D\u0435 \u0443\u0434\u0430\u043B\u0430\u0441\u044C: {error}",
    pt: "Falha na limpeza da configura\xE7\xE3o legada: {error}",
    nl: "Opschonen van oude configuratie mislukt: {error}",
    fr: "\xC9chec du nettoyage de l'ancienne configuration : {error}",
    it: "Pulizia della vecchia configurazione fallita: {error}",
    es: "Fall\xF3 la limpieza de la configuraci\xF3n antigua: {error}",
    pl: "Czyszczenie starej konfiguracji nie powiod\u0142o si\u0119: {error}",
    uk: "\u041E\u0447\u0438\u0449\u0435\u043D\u043D\u044F \u0441\u0442\u0430\u0440\u043E\u0457 \u043A\u043E\u043D\u0444\u0456\u0433\u0443\u0440\u0430\u0446\u0456\u0457 \u043D\u0435 \u0432\u0434\u0430\u043B\u043E\u0441\u044F: {error}",
    "zh-cn": "\u65E7\u914D\u7F6E\u6E05\u7406\u5931\u8D25: {error}"
  },
  staleClientGcRemoved: {
    en: "Removed {count} inactive client(s) (idle longer than 30 days)",
    de: "{count} inaktive Ger\xE4te entfernt (l\xE4nger als 30 Tage nicht gesehen)",
    ru: "\u0423\u0434\u0430\u043B\u0435\u043D\u043E {count} \u043D\u0435\u0430\u043A\u0442\u0438\u0432\u043D\u044B\u0445 \u043A\u043B\u0438\u0435\u043D\u0442\u043E\u0432 (\u043D\u0435\u0430\u043A\u0442\u0438\u0432\u043D\u044B \u0431\u043E\u043B\u0435\u0435 30 \u0434\u043D\u0435\u0439)",
    pt: "Removidos {count} cliente(s) inativos (inativos h\xE1 mais de 30 dias)",
    nl: "{count} inactieve client(s) verwijderd (langer dan 30 dagen niet actief)",
    fr: "{count} client(s) inactif(s) supprim\xE9(s) (inactivit\xE9 de plus de 30 jours)",
    it: "Rimossi {count} client inattivi (inattivi da oltre 30 giorni)",
    es: "Eliminados {count} cliente(s) inactivos (inactivos m\xE1s de 30 d\xEDas)",
    pl: "Usuni\u0119to {count} nieaktywnych klient\xF3w (nieaktywni d\u0142u\u017Cej ni\u017C 30 dni)",
    uk: "\u0412\u0438\u0434\u0430\u043B\u0435\u043D\u043E {count} \u043D\u0435\u0430\u043A\u0442\u0438\u0432\u043D\u0438\u0445 \u043A\u043B\u0456\u0454\u043D\u0442\u0456\u0432 (\u043D\u0435\u0430\u043A\u0442\u0438\u0432\u043D\u0456 \u0431\u0456\u043B\u044C\u0448\u0435 30 \u0434\u043D\u0456\u0432)",
    "zh-cn": "\u5DF2\u79FB\u9664 {count} \u4E2A\u4E0D\u6D3B\u8DC3\u5BA2\u6237\u7AEF\uFF08\u8D85\u8FC7 30 \u5929\u672A\u6D3B\u52A8\uFF09"
  },
  urlRefreshDone: {
    en: "URL list refreshed on user request",
    de: "URL-Liste auf Wunsch des Users neu eingelesen",
    ru: "\u0421\u043F\u0438\u0441\u043E\u043A URL \u043E\u0431\u043D\u043E\u0432\u043B\u0451\u043D \u043F\u043E \u0437\u0430\u043F\u0440\u043E\u0441\u0443 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F",
    pt: "Lista de URLs atualizada a pedido do utilizador",
    nl: "URL-lijst vernieuwd op verzoek van de gebruiker",
    fr: "Liste des URL actualis\xE9e \xE0 la demande de l'utilisateur",
    it: "Elenco URL aggiornato su richiesta dell'utente",
    es: "Lista de URLs actualizada a petici\xF3n del usuario",
    pl: "Lista URL od\u015Bwie\u017Cona na \u017C\u0105danie u\u017Cytkownika",
    uk: "\u0421\u043F\u0438\u0441\u043E\u043A URL \u043E\u043D\u043E\u0432\u043B\u0435\u043D\u043E \u043D\u0430 \u0437\u0430\u043F\u0438\u0442 \u043A\u043E\u0440\u0438\u0441\u0442\u0443\u0432\u0430\u0447\u0430",
    "zh-cn": "\u5DF2\u6839\u636E\u7528\u6237\u8BF7\u6C42\u5237\u65B0 URL \u5217\u8868"
  },
  urlRefreshFailed: {
    en: "URL refresh failed: {error}",
    de: "URL-Aktualisierung fehlgeschlagen: {error}",
    ru: "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u0431\u043D\u043E\u0432\u0438\u0442\u044C URL: {error}",
    pt: "Falha ao atualizar URLs: {error}",
    nl: "URL-vernieuwing mislukt: {error}",
    fr: "\xC9chec de l\u2019actualisation des URL : {error}",
    it: "Aggiornamento URL fallito: {error}",
    es: "Fall\xF3 la actualizaci\xF3n de URLs: {error}",
    pl: "Od\u015Bwie\u017Canie URL nie powiod\u0142o si\u0119: {error}",
    uk: "\u041D\u0435 \u0432\u0434\u0430\u043B\u043E\u0441\u044F \u043E\u043D\u043E\u0432\u0438\u0442\u0438 URL: {error}",
    "zh-cn": "URL \u5237\u65B0\u5931\u8D25: {error}"
  },
  clientForgotten: {
    en: "Client forgotten: {id}",
    de: "Ger\xE4t entfernt: {id}",
    ru: "\u041A\u043B\u0438\u0435\u043D\u0442 \u0443\u0434\u0430\u043B\u0451\u043D: {id}",
    pt: "Cliente removido: {id}",
    nl: "Client verwijderd: {id}",
    fr: "Client supprim\xE9 : {id}",
    it: "Client rimosso: {id}",
    es: "Cliente eliminado: {id}",
    pl: "Klient usuni\u0119ty: {id}",
    uk: "\u041A\u043B\u0456\u0454\u043D\u0442 \u0432\u0438\u0434\u0430\u043B\u0435\u043D\u043E: {id}",
    "zh-cn": "\u5DF2\u79FB\u9664\u5BA2\u6237\u7AEF: {id}"
  },
  newClientRegisteredWithHost: {
    en: "New client connected: {id} ({hostname})",
    de: "Neues Ger\xE4t verbunden: {id} ({hostname})",
    ru: "\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0451\u043D \u043D\u043E\u0432\u044B\u0439 \u043A\u043B\u0438\u0435\u043D\u0442: {id} ({hostname})",
    pt: "Novo cliente ligado: {id} ({hostname})",
    nl: "Nieuwe client verbonden: {id} ({hostname})",
    fr: "Nouveau client connect\xE9 : {id} ({hostname})",
    it: "Nuovo client connesso: {id} ({hostname})",
    es: "Nuevo cliente conectado: {id} ({hostname})",
    pl: "Nowy klient po\u0142\u0105czony: {id} ({hostname})",
    uk: "\u041D\u043E\u0432\u0438\u0439 \u043A\u043B\u0456\u0454\u043D\u0442 \u043F\u0456\u0434\u2019\u0454\u0434\u043D\u0430\u043D\u043E: {id} ({hostname})",
    "zh-cn": "\u65B0\u5BA2\u6237\u7AEF\u5DF2\u8FDE\u63A5: {id} ({hostname})"
  },
  newClientRegistered: {
    en: "New client connected: {id}",
    de: "Neues Ger\xE4t verbunden: {id}",
    ru: "\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0451\u043D \u043D\u043E\u0432\u044B\u0439 \u043A\u043B\u0438\u0435\u043D\u0442: {id}",
    pt: "Novo cliente ligado: {id}",
    nl: "Nieuwe client verbonden: {id}",
    fr: "Nouveau client connect\xE9 : {id}",
    it: "Nuovo client connesso: {id}",
    es: "Nuevo cliente conectado: {id}",
    pl: "Nowy klient po\u0142\u0105czony: {id}",
    uk: "\u041D\u043E\u0432\u0438\u0439 \u043A\u043B\u0456\u0454\u043D\u0442 \u043F\u0456\u0434\u2019\u0454\u0434\u043D\u0430\u043D\u043E: {id}",
    "zh-cn": "\u65B0\u5BA2\u6237\u7AEF\u5DF2\u8FDE\u63A5: {id}"
  },
  cookieBurstDetected: {
    en: "IP {ip} created {count} clients within an hour \u2014 display likely is not persisting cookies (privacy mode? refresh bug?)",
    de: "IP {ip} hat {count} Clients in unter einer Stunde erzeugt \u2014 das Display beh\xE4lt den Cookie wohl nicht (Privacy-Modus? Refresh-Bug?)",
    ru: "IP {ip} \u0441\u043E\u0437\u0434\u0430\u043B {count} \u043A\u043B\u0438\u0435\u043D\u0442\u043E\u0432 \u043C\u0435\u043D\u0435\u0435 \u0447\u0435\u043C \u0437\u0430 \u0447\u0430\u0441 \u2014 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u043E, \u043F\u043E\u0445\u043E\u0436\u0435, \u043D\u0435 \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u0435\u0442 cookie",
    pt: "IP {ip} criou {count} clientes em menos de uma hora \u2014 o ecr\xE3 provavelmente n\xE3o ret\xE9m o cookie",
    nl: "IP {ip} heeft {count} clients in minder dan een uur aangemaakt \u2014 display behoudt cookie waarschijnlijk niet",
    fr: "IP {ip} a cr\xE9\xE9 {count} clients en moins d\u2019une heure \u2014 l\u2019\xE9cran ne conserve probablement pas son cookie",
    it: "IP {ip} ha creato {count} client in meno di un\u2019ora \u2014 il display probabilmente non conserva il cookie",
    es: "IP {ip} cre\xF3 {count} clientes en menos de una hora \u2014 la pantalla probablemente no conserva la cookie",
    pl: "IP {ip} utworzy\u0142 {count} klient\xF3w w mniej ni\u017C godzin\u0119 \u2014 wy\u015Bwietlacz prawdopodobnie nie zachowuje cookie",
    uk: "IP {ip} \u0441\u0442\u0432\u043E\u0440\u0438\u0432 {count} \u043A\u043B\u0456\u0454\u043D\u0442\u0456\u0432 \u043C\u0435\u043D\u0448 \u043D\u0456\u0436 \u0437\u0430 \u0433\u043E\u0434\u0438\u043D\u0443 \u2014 \u043F\u0440\u0438\u0441\u0442\u0440\u0456\u0439, \u0439\u043C\u043E\u0432\u0456\u0440\u043D\u043E, \u043D\u0435 \u0437\u0431\u0435\u0440\u0456\u0433\u0430\u0454 cookie",
    "zh-cn": "IP {ip} \u5728\u4E0D\u5230\u4E00\u5C0F\u65F6\u5185\u521B\u5EFA\u4E86 {count} \u4E2A\u5BA2\u6237\u7AEF \u2014 \u663E\u793A\u5668\u53EF\u80FD\u672A\u4FDD\u7559 Cookie"
  },
  clientModeManualButEmpty: {
    en: 'Client {id}: mode set to "manual" but manualUrl is empty \u2014 fill clients.{id}.manualUrl to redirect',
    de: 'Ger\xE4t {id}: Modus auf \u201Emanuell" gesetzt, aber manualUrl ist leer \u2014 bitte clients.{id}.manualUrl f\xFCllen',
    ru: "\u041A\u043B\u0438\u0435\u043D\u0442 {id}: \u0443\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D \u0440\u0443\u0447\u043D\u043E\u0439 \u0440\u0435\u0436\u0438\u043C, \u043D\u043E manualUrl \u043F\u0443\u0441\u0442 \u2014 \u0437\u0430\u043F\u043E\u043B\u043D\u0438\u0442\u0435 clients.{id}.manualUrl",
    pt: 'Cliente {id}: modo definido como "manual" mas manualUrl est\xE1 vazio \u2014 preencha clients.{id}.manualUrl',
    nl: 'Client {id}: modus op "manual" gezet maar manualUrl is leeg \u2014 vul clients.{id}.manualUrl in',
    fr: "Client {id} : mode d\xE9fini sur \xAB manual \xBB mais manualUrl est vide \u2014 remplissez clients.{id}.manualUrl",
    it: 'Client {id}: modalit\xE0 impostata su "manual" ma manualUrl \xE8 vuoto \u2014 compilare clients.{id}.manualUrl',
    es: 'Cliente {id}: modo establecido en "manual" pero manualUrl est\xE1 vac\xEDo \u2014 rellena clients.{id}.manualUrl',
    pl: 'Klient {id}: tryb ustawiony na \u201Emanual", ale manualUrl jest pusty \u2014 uzupe\u0142nij clients.{id}.manualUrl',
    uk: "\u041A\u043B\u0456\u0454\u043D\u0442 {id}: \u0440\u0435\u0436\u0438\u043C \xABmanual\xBB, \u0430\u043B\u0435 manualUrl \u043F\u043E\u0440\u043E\u0436\u043D\u0456\u0439 \u2014 \u0437\u0430\u043F\u043E\u0432\u043D\u0456\u0442\u044C clients.{id}.manualUrl",
    "zh-cn": '\u5BA2\u6237\u7AEF {id}: \u6A21\u5F0F\u8BBE\u4E3A "manual" \u4F46 manualUrl \u4E3A\u7A7A \u2014 \u8BF7\u586B\u5199 clients.{id}.manualUrl'
  },
  clientModeUnsafe: {
    en: 'Client {id}: rejected unsafe mode value "{value}"',
    de: 'Ger\xE4t {id}: unsicherer Modus-Wert \u201E{value}" abgelehnt',
    ru: '\u041A\u043B\u0438\u0435\u043D\u0442 {id}: \u043E\u0442\u043A\u043B\u043E\u043D\u0435\u043D\u043E \u043D\u0435\u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435 \u0440\u0435\u0436\u0438\u043C\u0430 "{value}"',
    pt: 'Cliente {id}: valor de modo inseguro "{value}" rejeitado',
    nl: 'Client {id}: onveilige modus-waarde "{value}" afgewezen',
    fr: "Client {id} : valeur de mode non s\xFBre \xAB {value} \xBB rejet\xE9e",
    it: 'Client {id}: valore di modalit\xE0 non sicuro "{value}" rifiutato',
    es: 'Cliente {id}: valor de modo inseguro "{value}" rechazado',
    pl: 'Klient {id}: odrzucono niebezpieczn\u0105 warto\u015B\u0107 trybu \u201E{value}"',
    uk: "\u041A\u043B\u0456\u0454\u043D\u0442 {id}: \u0432\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E \u043D\u0435\u0431\u0435\u0437\u043F\u0435\u0447\u043D\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F \u0440\u0435\u0436\u0438\u043C\u0443 \xAB{value}\xBB",
    "zh-cn": '\u5BA2\u6237\u7AEF {id}: \u62D2\u7EDD\u4E0D\u5B89\u5168\u7684\u6A21\u5F0F\u503C "{value}"'
  },
  clientManualUrlUnsafe: {
    en: "Client {id}: rejected unsafe manualUrl value",
    de: "Ger\xE4t {id}: unsicherer manualUrl-Wert abgelehnt",
    ru: "\u041A\u043B\u0438\u0435\u043D\u0442 {id}: \u043E\u0442\u043A\u043B\u043E\u043D\u0451\u043D \u043D\u0435\u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u044B\u0439 manualUrl",
    pt: "Cliente {id}: manualUrl inseguro rejeitado",
    nl: "Client {id}: onveilige manualUrl afgewezen",
    fr: "Client {id} : manualUrl non s\xFBr rejet\xE9",
    it: "Client {id}: manualUrl non sicuro rifiutato",
    es: "Cliente {id}: manualUrl inseguro rechazado",
    pl: "Klient {id}: odrzucono niebezpieczny manualUrl",
    uk: "\u041A\u043B\u0456\u0454\u043D\u0442 {id}: \u0432\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E \u043D\u0435\u0431\u0435\u0437\u043F\u0435\u0447\u043D\u0438\u0439 manualUrl",
    "zh-cn": "\u5BA2\u6237\u7AEF {id}: \u62D2\u7EDD\u4E0D\u5B89\u5168\u7684 manualUrl"
  },
  clientManualUrlClearedWhileManual: {
    en: 'Client {id}: manualUrl cleared while mode is "manual" \u2014 display will see the setup page',
    de: 'Ger\xE4t {id}: manualUrl gel\xF6scht obwohl Modus \u201Emanuell" ist \u2014 das Display zeigt die Setup-Seite',
    ru: '\u041A\u043B\u0438\u0435\u043D\u0442 {id}: manualUrl \u043E\u0447\u0438\u0449\u0435\u043D, \u043F\u043E\u043A\u0430 \u0440\u0435\u0436\u0438\u043C "manual" \u2014 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u043E \u0443\u0432\u0438\u0434\u0438\u0442 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438',
    pt: 'Cliente {id}: manualUrl limpo enquanto o modo \xE9 "manual" \u2014 o ecr\xE3 ver\xE1 a p\xE1gina de configura\xE7\xE3o',
    nl: 'Client {id}: manualUrl gewist terwijl modus "manual" is \u2014 display ziet de setup-pagina',
    fr: "Client {id} : manualUrl effac\xE9 alors que le mode est \xAB manual \xBB \u2014 l\u2019\xE9cran verra la page de configuration",
    it: 'Client {id}: manualUrl cancellato mentre la modalit\xE0 \xE8 "manual" \u2014 il display vedr\xE0 la pagina di setup',
    es: 'Cliente {id}: manualUrl borrado mientras el modo es "manual" \u2014 la pantalla ver\xE1 la p\xE1gina de configuraci\xF3n',
    pl: 'Klient {id}: manualUrl wyczyszczony przy trybie \u201Emanual" \u2014 wy\u015Bwietlacz zobaczy stron\u0119 konfiguracji',
    uk: "\u041A\u043B\u0456\u0454\u043D\u0442 {id}: manualUrl \u043E\u0447\u0438\u0449\u0435\u043D\u043E, \u0442\u043E\u0434\u0456 \u044F\u043A \u0440\u0435\u0436\u0438\u043C \xABmanual\xBB \u2014 \u043F\u0440\u0438\u0441\u0442\u0440\u0456\u0439 \u043F\u043E\u0431\u0430\u0447\u0438\u0442\u044C \u0441\u0442\u043E\u0440\u0456\u043D\u043A\u0443 \u043D\u0430\u043B\u0430\u0448\u0442\u0443\u0432\u0430\u043D\u043D\u044F",
    "zh-cn": '\u5BA2\u6237\u7AEF {id}: \u6A21\u5F0F\u4E3A "manual" \u4F46 manualUrl \u5DF2\u6E05\u7A7A \u2014 \u663E\u793A\u5668\u5C06\u770B\u5230\u8BBE\u7F6E\u9875\u9762'
  },
  clientGlobalButGlobalEmpty: {
    en: 'Client {id}: mode is "global" but global has no resolvable URL \u2014 fill global.mode/manualUrl, or pick a different mode',
    de: 'Ger\xE4t {id}: Modus ist \u201Eglobal", aber global hat keine aufl\xF6sbare URL \u2014 bitte global.mode/manualUrl f\xFCllen oder anderen Modus w\xE4hlen',
    ru: '\u041A\u043B\u0438\u0435\u043D\u0442 {id}: \u0440\u0435\u0436\u0438\u043C "global", \u043D\u043E \u0432 global \u043D\u0435\u0442 URL \u2014 \u0437\u0430\u043F\u043E\u043B\u043D\u0438\u0442\u0435 global.mode/manualUrl \u0438\u043B\u0438 \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0434\u0440\u0443\u0433\u043E\u0439 \u0440\u0435\u0436\u0438\u043C',
    pt: 'Cliente {id}: modo \xE9 "global" mas global n\xE3o tem URL \u2014 preencha global.mode/manualUrl ou escolha outro modo',
    nl: 'Client {id}: modus "global" maar global heeft geen URL \u2014 vul global.mode/manualUrl in of kies een andere modus',
    fr: "Client {id} : mode \xAB global \xBB mais global n\u2019a pas d\u2019URL \u2014 remplissez global.mode/manualUrl ou choisissez un autre mode",
    it: 'Client {id}: modalit\xE0 "global" ma global non ha URL \u2014 compilare global.mode/manualUrl o scegliere un\u2019altra modalit\xE0',
    es: 'Cliente {id}: modo "global" pero global no tiene URL \u2014 rellena global.mode/manualUrl o elige otro modo',
    pl: 'Klient {id}: tryb \u201Eglobal", ale global nie ma URL \u2014 uzupe\u0142nij global.mode/manualUrl lub wybierz inny tryb',
    uk: "\u041A\u043B\u0456\u0454\u043D\u0442 {id}: \u0440\u0435\u0436\u0438\u043C \xABglobal\xBB, \u0430\u043B\u0435 global \u043D\u0435 \u043C\u0430\u0454 URL \u2014 \u0437\u0430\u043F\u043E\u0432\u043D\u0456\u0442\u044C global.mode/manualUrl \u0430\u0431\u043E \u0432\u0438\u0431\u0435\u0440\u0456\u0442\u044C \u0456\u043D\u0448\u0438\u0439 \u0440\u0435\u0436\u0438\u043C",
    "zh-cn": '\u5BA2\u6237\u7AEF {id}: \u6A21\u5F0F\u4E3A "global" \u4F46 global \u65E0\u53EF\u7528 URL \u2014 \u8BF7\u586B\u5199 global.mode/manualUrl \u6216\u9009\u62E9\u5176\u4ED6\u6A21\u5F0F'
  },
  globalModeNonString: {
    en: "global.mode rejected \u2014 non-string value",
    de: "global.mode abgelehnt \u2014 Wert ist kein String",
    ru: "global.mode \u043E\u0442\u043A\u043B\u043E\u043D\u0451\u043D \u2014 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435 \u043D\u0435 \u044F\u0432\u043B\u044F\u0435\u0442\u0441\u044F \u0441\u0442\u0440\u043E\u043A\u043E\u0439",
    pt: "global.mode rejeitado \u2014 valor n\xE3o \xE9 uma string",
    nl: "global.mode afgewezen \u2014 waarde is geen string",
    fr: "global.mode rejet\xE9 \u2014 la valeur n\u2019est pas une cha\xEEne",
    it: "global.mode rifiutato \u2014 il valore non \xE8 una stringa",
    es: "global.mode rechazado \u2014 el valor no es una cadena",
    pl: "global.mode odrzucony \u2014 warto\u015B\u0107 nie jest ci\u0105giem",
    uk: "global.mode \u0432\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E \u2014 \u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F \u043D\u0435 \u0454 \u0440\u044F\u0434\u043A\u043E\u043C",
    "zh-cn": "global.mode \u5DF2\u62D2\u7EDD \u2014 \u503C\u4E0D\u662F\u5B57\u7B26\u4E32"
  },
  globalModeSelfRef: {
    en: 'global.mode rejected \u2014 "global" is not allowed at the global level (self-referential)',
    de: 'global.mode abgelehnt \u2014 \u201Eglobal" ist auf der globalen Ebene nicht erlaubt (selbst-referenziell)',
    ru: 'global.mode \u043E\u0442\u043A\u043B\u043E\u043D\u0451\u043D \u2014 "global" \u043D\u0435\u0434\u043E\u043F\u0443\u0441\u0442\u0438\u043C \u043D\u0430 \u0433\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u043E\u043C \u0443\u0440\u043E\u0432\u043D\u0435 (\u0441\u0430\u043C\u043E\u0441\u0441\u044B\u043B\u043A\u0430)',
    pt: 'global.mode rejeitado \u2014 "global" n\xE3o \xE9 permitido no n\xEDvel global (auto-referencial)',
    nl: 'global.mode afgewezen \u2014 "global" is niet toegestaan op globaal niveau (zelf-referentieel)',
    fr: "global.mode rejet\xE9 \u2014 \xAB global \xBB n\u2019est pas autoris\xE9 au niveau global (auto-r\xE9f\xE9rence)",
    it: 'global.mode rifiutato \u2014 "global" non \xE8 consentito a livello globale (auto-referenziale)',
    es: 'global.mode rechazado \u2014 "global" no se permite en el nivel global (auto-referencial)',
    pl: 'global.mode odrzucony \u2014 \u201Eglobal" nie jest dozwolony na poziomie globalnym (samoodniesienie)',
    uk: "global.mode \u0432\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E \u2014 \xABglobal\xBB \u043D\u0435\u043F\u0440\u0438\u043F\u0443\u0441\u0442\u0438\u043C\u0438\u0439 \u043D\u0430 \u0433\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u043E\u043C\u0443 \u0440\u0456\u0432\u043D\u0456 (\u0441\u0430\u043C\u043E\u043F\u043E\u0441\u0438\u043B\u0430\u043D\u043D\u044F)",
    "zh-cn": 'global.mode \u5DF2\u62D2\u7EDD \u2014 "global" \u4E0D\u5141\u8BB8\u5728\u5168\u5C40\u5C42\u7EA7\uFF08\u81EA\u5F15\u7528\uFF09'
  },
  globalModeManualButEmpty: {
    en: 'global.mode is "manual" but global.manualUrl is empty \u2014 fill global.manualUrl to redirect',
    de: 'global.mode ist \u201Emanuell", aber global.manualUrl ist leer \u2014 bitte global.manualUrl f\xFCllen',
    ru: 'global.mode "manual", \u043D\u043E global.manualUrl \u043F\u0443\u0441\u0442 \u2014 \u0437\u0430\u043F\u043E\u043B\u043D\u0438\u0442\u0435 global.manualUrl',
    pt: 'global.mode \xE9 "manual" mas global.manualUrl est\xE1 vazio \u2014 preencha global.manualUrl',
    nl: 'global.mode is "manual" maar global.manualUrl is leeg \u2014 vul global.manualUrl in',
    fr: "global.mode est \xAB manual \xBB mais global.manualUrl est vide \u2014 remplissez global.manualUrl",
    it: 'global.mode \xE8 "manual" ma global.manualUrl \xE8 vuoto \u2014 compilare global.manualUrl',
    es: 'global.mode es "manual" pero global.manualUrl est\xE1 vac\xEDo \u2014 rellena global.manualUrl',
    pl: 'global.mode to \u201Emanual", ale global.manualUrl jest pusty \u2014 uzupe\u0142nij global.manualUrl',
    uk: "global.mode \xABmanual\xBB, \u0430\u043B\u0435 global.manualUrl \u043F\u043E\u0440\u043E\u0436\u043D\u0456\u0439 \u2014 \u0437\u0430\u043F\u043E\u0432\u043D\u0456\u0442\u044C global.manualUrl",
    "zh-cn": 'global.mode \u4E3A "manual" \u4F46 global.manualUrl \u4E3A\u7A7A \u2014 \u8BF7\u586B\u5199 global.manualUrl'
  },
  globalModeUnsafe: {
    en: 'global.mode rejected \u2014 unsafe URL value "{value}"',
    de: 'global.mode abgelehnt \u2014 unsicherer URL-Wert \u201E{value}"',
    ru: 'global.mode \u043E\u0442\u043A\u043B\u043E\u043D\u0451\u043D \u2014 \u043D\u0435\u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u044B\u0439 URL "{value}"',
    pt: 'global.mode rejeitado \u2014 URL inseguro "{value}"',
    nl: 'global.mode afgewezen \u2014 onveilige URL "{value}"',
    fr: "global.mode rejet\xE9 \u2014 URL non s\xFBre \xAB {value} \xBB",
    it: 'global.mode rifiutato \u2014 URL non sicuro "{value}"',
    es: 'global.mode rechazado \u2014 URL inseguro "{value}"',
    pl: 'global.mode odrzucony \u2014 niebezpieczny URL \u201E{value}"',
    uk: "global.mode \u0432\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E \u2014 \u043D\u0435\u0431\u0435\u0437\u043F\u0435\u0447\u043D\u0438\u0439 URL \xAB{value}\xBB",
    "zh-cn": 'global.mode \u5DF2\u62D2\u7EDD \u2014 \u4E0D\u5B89\u5168\u7684 URL \u503C "{value}"'
  },
  globalManualUrlUnsafe: {
    en: "global.manualUrl rejected \u2014 unsafe URL",
    de: "global.manualUrl abgelehnt \u2014 unsicherer URL",
    ru: "global.manualUrl \u043E\u0442\u043A\u043B\u043E\u043D\u0451\u043D \u2014 \u043D\u0435\u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u044B\u0439 URL",
    pt: "global.manualUrl rejeitado \u2014 URL inseguro",
    nl: "global.manualUrl afgewezen \u2014 onveilige URL",
    fr: "global.manualUrl rejet\xE9 \u2014 URL non s\xFBre",
    it: "global.manualUrl rifiutato \u2014 URL non sicuro",
    es: "global.manualUrl rechazado \u2014 URL inseguro",
    pl: "global.manualUrl odrzucony \u2014 niebezpieczny URL",
    uk: "global.manualUrl \u0432\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E \u2014 \u043D\u0435\u0431\u0435\u0437\u043F\u0435\u0447\u043D\u0438\u0439 URL",
    "zh-cn": "global.manualUrl \u5DF2\u62D2\u7EDD \u2014 URL \u4E0D\u5B89\u5168"
  },
  globalManualUrlClearedWhileManual: {
    en: 'global.manualUrl cleared while global.mode is "manual" \u2014 clients delegating to global will see the setup page',
    de: 'global.manualUrl gel\xF6scht obwohl global.mode \u201Emanuell" ist \u2014 Clients die global folgen sehen die Setup-Seite',
    ru: 'global.manualUrl \u043E\u0447\u0438\u0449\u0435\u043D, \u043F\u043E\u043A\u0430 global.mode "manual" \u2014 \u043A\u043B\u0438\u0435\u043D\u0442\u044B, \u043D\u0430\u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0435 global, \u0443\u0432\u0438\u0434\u044F\u0442 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438',
    pt: 'global.manualUrl limpo enquanto global.mode \xE9 "manual" \u2014 clientes que seguem global ver\xE3o a p\xE1gina de configura\xE7\xE3o',
    nl: 'global.manualUrl gewist terwijl global.mode "manual" is \u2014 clients die global volgen zien de setup-pagina',
    fr: "global.manualUrl effac\xE9 alors que global.mode est \xAB manual \xBB \u2014 les clients suivant global verront la page de configuration",
    it: 'global.manualUrl cancellato mentre global.mode \xE8 "manual" \u2014 i client che seguono global vedranno la pagina di setup',
    es: 'global.manualUrl borrado mientras global.mode es "manual" \u2014 los clientes que siguen global ver\xE1n la p\xE1gina de configuraci\xF3n',
    pl: 'global.manualUrl wyczyszczony przy global.mode \u201Emanual" \u2014 klienci \u015Bledz\u0105cy global zobacz\u0105 stron\u0119 konfiguracji',
    uk: "global.manualUrl \u043E\u0447\u0438\u0449\u0435\u043D\u043E, \u0442\u043E\u0434\u0456 \u044F\u043A global.mode \xABmanual\xBB \u2014 \u043A\u043B\u0456\u0454\u043D\u0442\u0438, \u0449\u043E \u0441\u043B\u0456\u0434\u0443\u044E\u0442\u044C global, \u043F\u043E\u0431\u0430\u0447\u0430\u0442\u044C \u0441\u0442\u043E\u0440\u0456\u043D\u043A\u0443 \u043D\u0430\u043B\u0430\u0448\u0442\u0443\u0432\u0430\u043D\u043D\u044F",
    "zh-cn": 'global.mode \u4E3A "manual" \u4F46 global.manualUrl \u5DF2\u6E05\u7A7A \u2014 \u8DDF\u968F global \u7684\u5BA2\u6237\u7AEF\u5C06\u770B\u5230\u8BBE\u7F6E\u9875\u9762'
  },
  loginRejectedLockout: {
    en: "Login rejected: IP {ip} is currently locked out (too many failed attempts)",
    de: "Login abgelehnt: IP {ip} ist gesperrt (zu viele fehlgeschlagene Versuche)",
    ru: "\u0412\u0445\u043E\u0434 \u043E\u0442\u043A\u043B\u043E\u043D\u0451\u043D: IP {ip} \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D (\u0441\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u043D\u043E\u0433\u043E \u043D\u0435\u0443\u0434\u0430\u0447\u043D\u044B\u0445 \u043F\u043E\u043F\u044B\u0442\u043E\u043A)",
    pt: "Login recusado: IP {ip} est\xE1 bloqueado (demasiadas tentativas falhadas)",
    nl: "Aanmelding geweigerd: IP {ip} is geblokkeerd (te veel mislukte pogingen)",
    fr: "Connexion refus\xE9e : l'IP {ip} est bloqu\xE9e (trop d'\xE9checs)",
    it: "Login rifiutato: IP {ip} bloccato (troppi tentativi falliti)",
    es: "Login rechazado: IP {ip} est\xE1 bloqueada (demasiados intentos fallidos)",
    pl: "Logowanie odrzucone: IP {ip} jest zablokowany (za du\u017Co nieudanych pr\xF3b)",
    uk: "\u0412\u0445\u0456\u0434 \u0432\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E: IP {ip} \u0437\u0430\u0431\u043B\u043E\u043A\u043E\u0432\u0430\u043D\u043E (\u0437\u0430\u0431\u0430\u0433\u0430\u0442\u043E \u043D\u0435\u0432\u0434\u0430\u043B\u0438\u0445 \u0441\u043F\u0440\u043E\u0431)",
    "zh-cn": "\u767B\u5F55\u88AB\u62D2\u7EDD\uFF1AIP {ip} \u5DF2\u88AB\u9501\u5B9A\uFF08\u5931\u8D25\u6B21\u6570\u8FC7\u591A\uFF09"
  },
  invalidCredentials: {
    en: "Invalid credentials{ipSuffix}",
    de: "Ung\xFCltige Zugangsdaten{ipSuffix}",
    ru: "\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0435 \u0443\u0447\u0451\u0442\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435{ipSuffix}",
    pt: "Credenciais inv\xE1lidas{ipSuffix}",
    nl: "Ongeldige inloggegevens{ipSuffix}",
    fr: "Identifiants invalides{ipSuffix}",
    it: "Credenziali non valide{ipSuffix}",
    es: "Credenciales no v\xE1lidas{ipSuffix}",
    pl: "Nieprawid\u0142owe dane logowania{ipSuffix}",
    uk: "\u041D\u0435\u0432\u0456\u0440\u043D\u0456 \u043E\u0431\u043B\u0456\u043A\u043E\u0432\u0456 \u0434\u0430\u043D\u0456{ipSuffix}",
    "zh-cn": "\u51ED\u636E\u65E0\u6548{ipSuffix}"
  },
  mdnsAsyncPublishError: {
    en: "mDNS async publish error: {error}",
    de: "mDNS-Ver\xF6ffentlichungsfehler: {error}",
    ru: "\u041E\u0448\u0438\u0431\u043A\u0430 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438 mDNS: {error}",
    pt: "Erro de publica\xE7\xE3o mDNS: {error}",
    nl: "mDNS-publicatiefout: {error}",
    fr: "Erreur de publication mDNS : {error}",
    it: "Errore di pubblicazione mDNS: {error}",
    es: "Error de publicaci\xF3n mDNS: {error}",
    pl: "B\u0142\u0105d publikacji mDNS: {error}",
    uk: "\u041F\u043E\u043C\u0438\u043B\u043A\u0430 \u043F\u0443\u0431\u043B\u0456\u043A\u0430\u0446\u0456\u0457 mDNS: {error}",
    "zh-cn": "mDNS \u53D1\u5E03\u9519\u8BEF: {error}"
  },
  mdnsStartFailed: {
    en: "mDNS failed to start: {error}",
    de: "mDNS konnte nicht gestartet werden: {error}",
    ru: "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C mDNS: {error}",
    pt: "mDNS falhou ao iniciar: {error}",
    nl: "mDNS kon niet starten: {error}",
    fr: "\xC9chec du d\xE9marrage de mDNS : {error}",
    it: "mDNS non \xE8 riuscito ad avviarsi: {error}",
    es: "mDNS no pudo iniciarse: {error}",
    pl: "mDNS nie m\xF3g\u0142 si\u0119 uruchomi\u0107: {error}",
    uk: "\u041D\u0435 \u0432\u0434\u0430\u043B\u043E\u0441\u044F \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0438 mDNS: {error}",
    "zh-cn": "mDNS \u542F\u52A8\u5931\u8D25: {error}"
  },
  mdnsStopFailed: {
    en: "mDNS could not stop cleanly: {error}",
    de: "mDNS konnte nicht sauber gestoppt werden: {error}",
    ru: "mDNS \u043D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u043E \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C: {error}",
    pt: "mDNS n\xE3o conseguiu parar corretamente: {error}",
    nl: "mDNS kon niet schoon stoppen: {error}",
    fr: "mDNS n\u2019a pas pu s\u2019arr\xEAter proprement : {error}",
    it: "mDNS non \xE8 riuscito a fermarsi correttamente: {error}",
    es: "mDNS no pudo detenerse limpiamente: {error}",
    pl: "mDNS nie m\xF3g\u0142 zatrzyma\u0107 si\u0119 czysto: {error}",
    uk: "mDNS \u043D\u0435 \u0432\u0434\u0430\u043B\u043E\u0441\u044F \u043A\u043E\u0440\u0435\u043A\u0442\u043D\u043E \u0437\u0443\u043F\u0438\u043D\u0438\u0442\u0438: {error}",
    "zh-cn": "mDNS \u672A\u80FD\u5E72\u51C0\u5730\u505C\u6B62: {error}"
  },
  requestError: {
    en: "Request error: {message}",
    de: "Anfrage-Fehler: {message}",
    ru: "\u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u043F\u0440\u043E\u0441\u0430: {message}",
    pt: "Erro no pedido: {message}",
    nl: "Verzoekfout: {message}",
    fr: "Erreur de requ\xEAte : {message}",
    it: "Errore richiesta: {message}",
    es: "Error de petici\xF3n: {message}",
    pl: "B\u0142\u0105d \u017C\u0105dania: {message}",
    uk: "\u041F\u043E\u043C\u0438\u043B\u043A\u0430 \u0437\u0430\u043F\u0438\u0442\u0443: {message}",
    "zh-cn": "\u8BF7\u6C42\u9519\u8BEF: {message}"
  },
  portAlreadyInUse: {
    en: "Port {port} is already in use \u2014 another service is bound to it",
    de: "Port {port} ist bereits belegt \u2014 ein anderer Dienst h\xF6rt darauf",
    ru: "\u041F\u043E\u0440\u0442 {port} \u0443\u0436\u0435 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u0442\u0441\u044F \u2014 \u043D\u0430 \u043D\u0451\u043C \u0441\u043B\u0443\u0448\u0430\u0435\u0442 \u0434\u0440\u0443\u0433\u0430\u044F \u0441\u043B\u0443\u0436\u0431\u0430",
    pt: "A porta {port} j\xE1 est\xE1 em uso \u2014 outro servi\xE7o est\xE1 ligado a ela",
    nl: "Poort {port} is al in gebruik \u2014 een andere service luistert erop",
    fr: "Le port {port} est d\xE9j\xE0 utilis\xE9 \u2014 un autre service y est li\xE9",
    it: "La porta {port} \xE8 gi\xE0 in uso \u2014 un altro servizio \xE8 in ascolto",
    es: "El puerto {port} ya est\xE1 en uso \u2014 otro servicio est\xE1 enlazado",
    pl: "Port {port} jest ju\u017C u\u017Cywany \u2014 inna us\u0142uga jest z nim powi\u0105zana",
    uk: "\u041F\u043E\u0440\u0442 {port} \u0432\u0436\u0435 \u0432\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u043E\u0432\u0443\u0454\u0442\u044C\u0441\u044F \u2014 \u0456\u043D\u0448\u0430 \u0441\u043B\u0443\u0436\u0431\u0430 \u043F\u0440\u0438\u0432\u2019\u044F\u0437\u0430\u043D\u0430",
    "zh-cn": "\u7AEF\u53E3 {port} \u5DF2\u88AB\u5360\u7528 \u2014 \u53E6\u4E00\u4E2A\u670D\u52A1\u7ED1\u5B9A\u5230\u8BE5\u7AEF\u53E3"
  },
  serverStartError: {
    en: "Server error during startup: {error}",
    de: "Server-Fehler beim Start: {error}",
    ru: "\u041E\u0448\u0438\u0431\u043A\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0430 \u043F\u0440\u0438 \u0437\u0430\u043F\u0443\u0441\u043A\u0435: {error}",
    pt: "Erro do servidor no arranque: {error}",
    nl: "Serverfout bij opstarten: {error}",
    fr: "Erreur serveur au d\xE9marrage : {error}",
    it: "Errore del server all'avvio: {error}",
    es: "Error del servidor al iniciar: {error}",
    pl: "B\u0142\u0105d serwera podczas uruchamiania: {error}",
    uk: "\u041F\u043E\u043C\u0438\u043B\u043A\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0430 \u043F\u0440\u0438 \u0437\u0430\u043F\u0443\u0441\u043A\u0443: {error}",
    "zh-cn": "\u670D\u52A1\u5668\u542F\u52A8\u65F6\u51FA\u9519: {error}"
  },
  loginLockoutTriggered: {
    en: "Login lockout: IP {ip} reached {threshold} failed attempts \u2014 locked for {minutes} min",
    de: "Login-Sperre: IP {ip} hat {threshold} Fehlversuche erreicht \u2014 gesperrt f\xFCr {minutes} Min",
    ru: "\u0411\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u043A\u0430 \u0432\u0445\u043E\u0434\u0430: IP {ip} \u0434\u043E\u0441\u0442\u0438\u0433 {threshold} \u043D\u0435\u0443\u0434\u0430\u0447\u043D\u044B\u0445 \u043F\u043E\u043F\u044B\u0442\u043E\u043A \u2014 \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D \u043D\u0430 {minutes} \u043C\u0438\u043D",
    pt: "Bloqueio de login: IP {ip} atingiu {threshold} tentativas falhadas \u2014 bloqueado por {minutes} min",
    nl: "Aanmeldingsblokkade: IP {ip} heeft {threshold} mislukte pogingen bereikt \u2014 geblokkeerd voor {minutes} min",
    fr: "Verrouillage de connexion : l'IP {ip} a atteint {threshold} \xE9checs \u2014 bloqu\xE9e pour {minutes} min",
    it: "Blocco accesso: IP {ip} ha raggiunto {threshold} tentativi falliti \u2014 bloccato per {minutes} min",
    es: "Bloqueo de inicio de sesi\xF3n: IP {ip} alcanz\xF3 {threshold} intentos fallidos \u2014 bloqueado por {minutes} min",
    pl: "Blokada logowania: IP {ip} osi\u0105gn\u0105\u0142 {threshold} nieudanych pr\xF3b \u2014 zablokowany na {minutes} min",
    uk: "\u0411\u043B\u043E\u043A\u0443\u0432\u0430\u043D\u043D\u044F \u0432\u0445\u043E\u0434\u0443: IP {ip} \u0434\u043E\u0441\u044F\u0433 {threshold} \u043D\u0435\u0432\u0434\u0430\u043B\u0438\u0445 \u0441\u043F\u0440\u043E\u0431 \u2014 \u0437\u0430\u0431\u043B\u043E\u043A\u043E\u0432\u0430\u043D\u043E \u043D\u0430 {minutes} \u0445\u0432",
    "zh-cn": "\u767B\u5F55\u9501\u5B9A\uFF1AIP {ip} \u5DF2\u8FBE\u5230 {threshold} \u6B21\u5931\u8D25\u5C1D\u8BD5 \u2014 \u9501\u5B9A {minutes} \u5206\u949F"
  }
};
function tLog(lang, key, params) {
  var _a;
  const langKey = SUPPORTED_LANGS.includes(lang) ? lang : "en";
  const bundle = LOG_STRINGS[key];
  const template = (_a = bundle[langKey]) != null ? _a : bundle.en;
  return fmt(template, params);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LOG_STRINGS,
  tLog
});
//# sourceMappingURL=i18n-logs.js.map
