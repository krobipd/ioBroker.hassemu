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
var i18n_states_exports = {};
__export(i18n_states_exports, {
  STATE_DESCS: () => STATE_DESCS,
  STATE_LABELS: () => STATE_LABELS,
  STATE_NAMES: () => STATE_NAMES,
  resolveLabel: () => resolveLabel,
  tDesc: () => tDesc,
  tLabel: () => tLabel,
  tName: () => tName
});
module.exports = __toCommonJS(i18n_states_exports);
const STATE_NAMES = {
  info: {
    en: "Information",
    de: "Information",
    ru: "\u0418\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u044F",
    pt: "Informa\xE7\xE3o",
    nl: "Informatie",
    fr: "Informations",
    it: "Informazioni",
    es: "Informaci\xF3n",
    pl: "Informacje",
    uk: "\u0406\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0456\u044F",
    "zh-cn": "\u4FE1\u606F"
  },
  connection: {
    en: "Server is running",
    de: "Server l\xE4uft",
    ru: "\u0421\u0435\u0440\u0432\u0435\u0440 \u0437\u0430\u043F\u0443\u0449\u0435\u043D",
    pt: "Servidor em execu\xE7\xE3o",
    nl: "Server draait",
    fr: "Serveur en marche",
    it: "Server in esecuzione",
    es: "Servidor en ejecuci\xF3n",
    pl: "Serwer dzia\u0142a",
    uk: "\u0421\u0435\u0440\u0432\u0435\u0440 \u043F\u0440\u0430\u0446\u044E\u0454",
    "zh-cn": "\u670D\u52A1\u5668\u8FD0\u884C\u4E2D"
  },
  serverUuid: {
    en: "HA-server UUID (stable across restarts)",
    de: "HA-Server-UUID (bleibt \xFCber Neustarts hinweg)",
    ru: "UUID HA-\u0441\u0435\u0440\u0432\u0435\u0440\u0430 (\u0441\u0442\u0430\u0431\u0438\u043B\u0435\u043D \u043F\u0440\u0438 \u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u043A\u0430\u0445)",
    pt: "UUID do servidor HA (est\xE1vel entre rein\xEDcios)",
    nl: "HA-server UUID (stabiel over herstarts)",
    fr: "UUID du serveur HA (stable entre les red\xE9marrages)",
    it: "UUID del server HA (stabile tra i riavvii)",
    es: "UUID del servidor HA (estable entre reinicios)",
    pl: "UUID serwera HA (stabilny mi\u0119dzy restartami)",
    uk: "UUID HA-\u0441\u0435\u0440\u0432\u0435\u0440\u0430 (\u0441\u0442\u0430\u0431\u0456\u043B\u044C\u043D\u0438\u0439 \u043C\u0456\u0436 \u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u043A\u0430\u043C\u0438)",
    "zh-cn": "HA \u670D\u52A1\u5668 UUID\uFF08\u91CD\u542F\u540E\u4FDD\u6301\u4E0D\u53D8\uFF09"
  },
  refreshUrls: {
    en: "Refresh URL discovery",
    de: "URL-Erkennung neu laden",
    ru: "\u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C URL-\u043E\u0431\u043D\u0430\u0440\u0443\u0436\u0435\u043D\u0438\u0435",
    pt: "Atualizar dete\xE7\xE3o de URLs",
    nl: "URL-ontdekking vernieuwen",
    fr: "Rafra\xEEchir la d\xE9couverte des URL",
    it: "Aggiorna rilevamento URL",
    es: "Refrescar detecci\xF3n de URLs",
    pl: "Od\u015Bwie\u017C wykrywanie URL",
    uk: "\u041E\u043D\u043E\u0432\u0438\u0442\u0438 \u043F\u043E\u0448\u0443\u043A URL",
    "zh-cn": "\u5237\u65B0 URL \u53D1\u73B0"
  },
  clients: {
    en: "Known display clients",
    de: "Bekannte Display-Clients",
    ru: "\u0418\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0435 display-\u043A\u043B\u0438\u0435\u043D\u0442\u044B",
    pt: "Clientes de ecr\xE3 conhecidos",
    nl: "Bekende display-clients",
    fr: "Clients d\u2019affichage connus",
    it: "Client di display noti",
    es: "Clientes de pantalla conocidos",
    pl: "Znani klienci wy\u015Bwietlaczy",
    uk: "\u0412\u0456\u0434\u043E\u043C\u0456 \u043A\u043B\u0456\u0454\u043D\u0442\u0438 \u0434\u0438\u0441\u043F\u043B\u0435\u0457\u0432",
    "zh-cn": "\u5DF2\u77E5\u663E\u793A\u5BA2\u6237\u7AEF"
  },
  global: {
    en: "Global redirect override",
    de: "Globaler Weiterleitungs-Override",
    ru: "\u0413\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u043E\u0435 \u043F\u0435\u0440\u0435\u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0435\u043D\u0438\u0435 redirect",
    pt: "Substitui\xE7\xE3o global de redireccionamento",
    nl: "Globale redirect-override",
    fr: "Substitution globale de redirection",
    it: "Override globale del redirect",
    es: "Sobrescritura global de redirecci\xF3n",
    pl: "Globalny redirect override",
    uk: "\u0413\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u0435 \u043F\u0435\u0440\u0435\u0432\u0438\u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F redirect",
    "zh-cn": "\u5168\u5C40\u91CD\u5B9A\u5411\u8986\u76D6"
  },
  globalEnabled: {
    en: "Apply global URL to all clients",
    de: "Globale URL f\xFCr alle Clients anwenden",
    ru: "\u041F\u0440\u0438\u043C\u0435\u043D\u044F\u0442\u044C \u0433\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u044B\u0439 URL \u0434\u043B\u044F \u0432\u0441\u0435\u0445 \u043A\u043B\u0438\u0435\u043D\u0442\u043E\u0432",
    pt: "Aplicar URL global a todos os clientes",
    nl: "Globale URL toepassen op alle clients",
    fr: "Appliquer l\u2019URL globale \xE0 tous les clients",
    it: "Applica URL globale a tutti i client",
    es: "Aplicar URL global a todos los clientes",
    pl: "Stosuj globalny URL do wszystkich klient\xF3w",
    uk: "\u0417\u0430\u0441\u0442\u043E\u0441\u0443\u0432\u0430\u0442\u0438 \u0433\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u0438\u0439 URL \u0434\u043E \u0432\u0441\u0456\u0445 \u043A\u043B\u0456\u0454\u043D\u0442\u0456\u0432",
    "zh-cn": "\u5C06\u5168\u5C40 URL \u5E94\u7528\u5230\u6240\u6709\u5BA2\u6237\u7AEF"
  },
  globalMode: {
    en: "Global redirect mode",
    de: "Globaler Weiterleitungs-Modus",
    ru: "\u0413\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C redirect",
    pt: "Modo de redireccionamento global",
    nl: "Globale redirect-modus",
    fr: "Mode de redirection global",
    it: "Modalit\xE0 di redirect globale",
    es: "Modo de redirecci\xF3n global",
    pl: "Globalny tryb redirect",
    uk: "\u0413\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u0438\u0439 \u0440\u0435\u0436\u0438\u043C redirect",
    "zh-cn": "\u5168\u5C40\u91CD\u5B9A\u5411\u6A21\u5F0F"
  },
  globalManualUrl: {
    en: "Global manual URL (used when mode='manual')",
    de: "Globale manuelle URL (genutzt wenn mode='manual')",
    ru: "\u0413\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u044B\u0439 \u0440\u0443\u0447\u043D\u043E\u0439 URL (\u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u0442\u0441\u044F \u043F\u0440\u0438 mode='manual')",
    pt: "URL manual global (usado quando mode='manual')",
    nl: "Globale handmatige URL (gebruikt als mode='manual')",
    fr: "URL manuelle globale (utilis\xE9e quand mode='manual')",
    it: "URL manuale globale (usato quando mode='manual')",
    es: "URL manual global (se usa cuando mode='manual')",
    pl: "Globalny r\u0119czny URL (gdy mode='manual')",
    uk: "\u0413\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u0438\u0439 \u0440\u0443\u0447\u043D\u0438\u0439 URL (\u043A\u043E\u043B\u0438 mode='manual')",
    "zh-cn": "\u5168\u5C40\u624B\u52A8 URL\uFF08\u5F53 mode='manual' \u65F6\u4F7F\u7528\uFF09"
  },
  clientMode: {
    en: "Redirect mode",
    de: "Weiterleitungs-Modus",
    ru: "\u0420\u0435\u0436\u0438\u043C redirect",
    pt: "Modo de redireccionamento",
    nl: "Redirect-modus",
    fr: "Mode de redirection",
    it: "Modalit\xE0 redirect",
    es: "Modo de redirecci\xF3n",
    pl: "Tryb redirect",
    uk: "\u0420\u0435\u0436\u0438\u043C redirect",
    "zh-cn": "\u91CD\u5B9A\u5411\u6A21\u5F0F"
  },
  clientManualUrl: {
    en: "Manual URL",
    de: "Manuelle URL",
    ru: "\u0420\u0443\u0447\u043D\u043E\u0439 URL",
    pt: "URL manual",
    nl: "Handmatige URL",
    fr: "URL manuelle",
    it: "URL manuale",
    es: "URL manual",
    pl: "R\u0119czny URL",
    uk: "\u0420\u0443\u0447\u043D\u0438\u0439 URL",
    "zh-cn": "\u624B\u52A8 URL"
  },
  clientIp: {
    en: "Client IP",
    de: "Client-IP",
    ru: "IP \u043A\u043B\u0438\u0435\u043D\u0442\u0430",
    pt: "IP do cliente",
    nl: "Client-IP",
    fr: "IP du client",
    it: "IP del client",
    es: "IP del cliente",
    pl: "IP klienta",
    uk: "IP \u043A\u043B\u0456\u0454\u043D\u0442\u0430",
    "zh-cn": "\u5BA2\u6237\u7AEF IP"
  },
  clientRemove: {
    en: "Forget this client",
    de: "Diesen Client entfernen",
    ru: "\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u044D\u0442\u043E\u0433\u043E \u043A\u043B\u0438\u0435\u043D\u0442\u0430",
    pt: "Esquecer este cliente",
    nl: "Deze client vergeten",
    fr: "Oublier ce client",
    it: "Dimentica questo client",
    es: "Olvidar este cliente",
    pl: "Zapomnij tego klienta",
    uk: "\u0417\u0430\u0431\u0443\u0442\u0438 \u0446\u044C\u043E\u0433\u043E \u043A\u043B\u0456\u0454\u043D\u0442\u0430",
    "zh-cn": "\u79FB\u9664\u6B64\u5BA2\u6237\u7AEF"
  }
};
const STATE_DESCS = {
  serverUuidDesc: {
    en: "Persistent UUID broadcast via mDNS and /api/discovery_info. Generated once on first start and re-used across restarts so HA-Clients don't treat each restart as a new server (which would invalidate cached identity, force re-onboarding and drop tokens).",
    de: "Persistente UUID, broadcastet via mDNS und /api/discovery_info. Wird beim ersten Start einmal erzeugt und \xFCber Neustarts hinweg wiederverwendet, sodass HA-Clients nicht jeden Neustart als neuen Server behandeln (was die gecachte Identit\xE4t ung\xFCltig machen, Re-Onboarding erzwingen und Tokens verwerfen w\xFCrde).",
    ru: "\u041F\u043E\u0441\u0442\u043E\u044F\u043D\u043D\u044B\u0439 UUID, \u0442\u0440\u0430\u043D\u0441\u043B\u0438\u0440\u0443\u0435\u043C\u044B\u0439 \u0447\u0435\u0440\u0435\u0437 mDNS \u0438 /api/discovery_info. \u0413\u0435\u043D\u0435\u0440\u0438\u0440\u0443\u0435\u0442\u0441\u044F \u043E\u0434\u0438\u043D \u0440\u0430\u0437 \u043F\u0440\u0438 \u043F\u0435\u0440\u0432\u043E\u043C \u0441\u0442\u0430\u0440\u0442\u0435 \u0438 \u043F\u0435\u0440\u0435\u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u0442\u0441\u044F \u043F\u0440\u0438 \u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u043A\u0430\u0445, \u0447\u0442\u043E\u0431\u044B HA-\u043A\u043B\u0438\u0435\u043D\u0442\u044B \u043D\u0435 \u0441\u0447\u0438\u0442\u0430\u043B\u0438 \u043A\u0430\u0436\u0434\u044B\u0439 \u0440\u0435\u0441\u0442\u0430\u0440\u0442 \u043D\u043E\u0432\u044B\u043C \u0441\u0435\u0440\u0432\u0435\u0440\u043E\u043C.",
    pt: "UUID persistente difundido via mDNS e /api/discovery_info. Gerado uma vez no primeiro arranque e reutilizado entre rein\xEDcios para que os clientes HA n\xE3o tratem cada rein\xEDcio como um novo servidor.",
    nl: "Persistente UUID die via mDNS en /api/discovery_info wordt uitgezonden. Wordt eenmaal gegenereerd bij de eerste start en blijft over herstarts behouden zodat HA-clients elke herstart niet als nieuwe server zien.",
    fr: "UUID persistant diffus\xE9 via mDNS et /api/discovery_info. G\xE9n\xE9r\xE9 une fois au premier d\xE9marrage et r\xE9utilis\xE9 entre red\xE9marrages, ainsi les clients HA ne traitent pas chaque red\xE9marrage comme un nouveau serveur.",
    it: "UUID persistente trasmesso via mDNS e /api/discovery_info. Generato una volta al primo avvio e riutilizzato tra i riavvii: cos\xEC i client HA non considerano ogni riavvio come un nuovo server.",
    es: "UUID persistente difundido v\xEDa mDNS y /api/discovery_info. Se genera una vez en el primer arranque y se reutiliza entre reinicios para que los clientes HA no traten cada reinicio como un servidor nuevo.",
    pl: "Trwa\u0142y UUID rozg\u0142aszany przez mDNS i /api/discovery_info. Generowany raz przy pierwszym starcie i ponownie u\u017Cywany przy restartach, aby klienci HA nie traktowali ka\u017Cdego restartu jako nowego serwera.",
    uk: "\u041F\u043E\u0441\u0442\u0456\u0439\u043D\u0438\u0439 UUID, \u0449\u043E \u0442\u0440\u0430\u043D\u0441\u043B\u044E\u0454\u0442\u044C\u0441\u044F \u0447\u0435\u0440\u0435\u0437 mDNS \u0442\u0430 /api/discovery_info. \u0421\u0442\u0432\u043E\u0440\u044E\u0454\u0442\u044C\u0441\u044F \u043E\u0434\u0438\u043D \u0440\u0430\u0437 \u043F\u0440\u0438 \u043F\u0435\u0440\u0448\u043E\u043C\u0443 \u0437\u0430\u043F\u0443\u0441\u043A\u0443 \u0439 \u043F\u043E\u0432\u0442\u043E\u0440\u043D\u043E \u0432\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u043E\u0432\u0443\u0454\u0442\u044C\u0441\u044F \u043F\u0456\u0441\u043B\u044F \u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u043A\u0456\u0432, \u0449\u043E\u0431 HA-\u043A\u043B\u0456\u0454\u043D\u0442\u0438 \u043D\u0435 \u0441\u043F\u0440\u0438\u0439\u043C\u0430\u043B\u0438 \u043A\u043E\u0436\u0435\u043D \u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u043A \u044F\u043A \u043D\u043E\u0432\u0438\u0439 \u0441\u0435\u0440\u0432\u0435\u0440.",
    "zh-cn": "\u901A\u8FC7 mDNS \u548C /api/discovery_info \u5E7F\u64AD\u7684\u6301\u4E45 UUID\u3002\u9996\u6B21\u542F\u52A8\u65F6\u751F\u6210\u4E00\u6B21\uFF0C\u91CD\u542F\u4E4B\u95F4\u590D\u7528\uFF0C\u907F\u514D HA \u5BA2\u6237\u7AEF\u6BCF\u6B21\u91CD\u542F\u90FD\u89C6\u4E3A\u65B0\u670D\u52A1\u5668\u3002"
  },
  refreshUrlsDesc: {
    en: "Write true to re-scan the broker for VIS/VIS-2 projects, Admin tiles and other discovered URLs. Useful after creating a new VIS view without restarting the adapter.",
    de: "Auf true setzen, um den Broker nach VIS/VIS-2-Projekten, Admin-Kacheln und weiteren URLs neu zu durchsuchen. Sinnvoll nach Anlegen einer neuen VIS-View ohne Adapter-Neustart.",
    ru: "\u0417\u0430\u043F\u0438\u0448\u0438\u0442\u0435 true, \u0447\u0442\u043E\u0431\u044B \u043F\u0435\u0440\u0435\u0441\u043A\u0430\u043D\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0431\u0440\u043E\u043A\u0435\u0440 \u043D\u0430 VIS/VIS-2-\u043F\u0440\u043E\u0435\u043A\u0442\u044B, Admin-\u043F\u043B\u0438\u0442\u043A\u0438 \u0438 \u0434\u0440\u0443\u0433\u0438\u0435 URL. \u0423\u0434\u043E\u0431\u043D\u043E \u043F\u043E\u0441\u043B\u0435 \u0441\u043E\u0437\u0434\u0430\u043D\u0438\u044F \u043D\u043E\u0432\u043E\u0439 VIS-view \u0431\u0435\u0437 \u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u043A\u0430 \u0430\u0434\u0430\u043F\u0442\u0435\u0440\u0430.",
    pt: "Escreve true para voltar a procurar projetos VIS/VIS-2, mosaicos Admin e outros URLs no broker. \xDAtil ap\xF3s criar uma nova view VIS sem reiniciar o adaptador.",
    nl: "Schrijf true om de broker opnieuw te scannen op VIS/VIS-2-projecten, admin-tegels en andere URLs. Handig na het aanmaken van een nieuwe VIS-view zonder de adapter te herstarten.",
    fr: "\xC9crivez true pour r\xE9-analyser le broker \xE0 la recherche de projets VIS/VIS-2, de tuiles Admin et d\u2019autres URL. Utile apr\xE8s la cr\xE9ation d\u2019une nouvelle vue VIS sans red\xE9marrer l\u2019adaptateur.",
    it: "Scrivi true per ri-scansionare il broker per progetti VIS/VIS-2, tile Admin e altri URL. Utile dopo aver creato una nuova view VIS senza riavviare l\u2019adattatore.",
    es: "Escribe true para volver a escanear el broker en busca de proyectos VIS/VIS-2, mosaicos Admin y otras URLs. \xDAtil tras crear una nueva vista VIS sin reiniciar el adaptador.",
    pl: "Wpisz true, aby ponownie przeszuka\u0107 broker pod k\u0105tem projekt\xF3w VIS/VIS-2, kafelk\xF3w Admin i innych URL. Przydatne po utworzeniu nowego widoku VIS bez restartu adaptera.",
    uk: "\u0417\u0430\u043F\u0438\u0448\u0456\u0442\u044C true, \u0449\u043E\u0431 \u043F\u043E\u0432\u0442\u043E\u0440\u043D\u043E \u0441\u043A\u0430\u043D\u0443\u0432\u0430\u0442\u0438 \u0431\u0440\u043E\u043A\u0435\u0440 \u043D\u0430 \u043F\u0440\u043E\u0435\u043A\u0442\u0438 VIS/VIS-2, admin-\u043F\u043B\u0438\u0442\u043A\u0438 \u0442\u0430 \u0456\u043D\u0448\u0456 URL. \u041A\u043E\u0440\u0438\u0441\u043D\u043E \u043F\u0456\u0441\u043B\u044F \u0441\u0442\u0432\u043E\u0440\u0435\u043D\u043D\u044F \u043D\u043E\u0432\u043E\u0457 VIS-view \u0431\u0435\u0437 \u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u043A\u0443 \u0430\u0434\u0430\u043F\u0442\u0435\u0440\u0430.",
    "zh-cn": "\u5199\u5165 true \u4EE5\u91CD\u65B0\u626B\u63CF broker \u4E0A\u7684 VIS/VIS-2 \u9879\u76EE\u3001Admin \u74F7\u8D34\u548C\u5176\u4ED6 URL\u3002\u5728\u4E0D\u91CD\u542F\u9002\u914D\u5668\u7684\u60C5\u51B5\u4E0B\u521B\u5EFA\u65B0 VIS \u89C6\u56FE\u540E\u5F88\u6709\u7528\u3002"
  }
};
const STATE_LABELS = {
  noChoice: {
    en: "---",
    de: "---",
    ru: "---",
    pt: "---",
    nl: "---",
    fr: "---",
    it: "---",
    es: "---",
    pl: "---",
    uk: "---",
    "zh-cn": "---"
  },
  globalUrl: {
    en: "Global URL",
    de: "Globale URL",
    ru: "\u0413\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u044B\u0439 URL",
    pt: "URL global",
    nl: "Globale URL",
    fr: "URL globale",
    it: "URL globale",
    es: "URL global",
    pl: "Globalny URL",
    uk: "\u0413\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u0438\u0439 URL",
    "zh-cn": "\u5168\u5C40 URL"
  },
  manualUrl: {
    en: "Manual URL",
    de: "Manuelle URL",
    ru: "\u0420\u0443\u0447\u043D\u043E\u0439 URL",
    pt: "URL manual",
    nl: "Handmatige URL",
    fr: "URL manuelle",
    it: "URL manuale",
    es: "URL manual",
    pl: "R\u0119czny URL",
    uk: "\u0420\u0443\u0447\u043D\u0438\u0439 URL",
    "zh-cn": "\u624B\u52A8 URL"
  }
};
function tName(key) {
  return STATE_NAMES[key];
}
function tDesc(key) {
  return STATE_DESCS[key];
}
function tLabel(key) {
  return STATE_LABELS[key];
}
function resolveLabel(key, lang) {
  var _a, _b;
  const obj = STATE_LABELS[key];
  if (typeof obj === "string") {
    return obj;
  }
  const dict = obj;
  return (_b = (_a = dict[lang]) != null ? _a : dict.en) != null ? _b : key;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  STATE_DESCS,
  STATE_LABELS,
  STATE_NAMES,
  resolveLabel,
  tDesc,
  tLabel,
  tName
});
//# sourceMappingURL=i18n-states.js.map
