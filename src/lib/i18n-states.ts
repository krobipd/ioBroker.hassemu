/**
 * Localized state names, descriptions and dropdown labels.
 *
 * ioBroker accepts plain strings or `{ en, de, ... }` translation objects for
 * `common.name`, `common.desc` and the values of `common.states`. Admin, vis
 * and the Object-Browser pick the user's language automatically — we just
 * hand them the object.
 *
 * No adapter-side lookup needed (different from `i18n-logs.ts`, where we have
 * to pick at log-emit time because `this.log.info(...)` takes a single
 * string).
 */

type Lang = 'en' | 'de' | 'ru' | 'pt' | 'nl' | 'fr' | 'it' | 'es' | 'pl' | 'uk' | 'zh-cn';

/** Translation object as ioBroker expects it. */
export type StateName = Record<Lang, string>;

/** State / channel display names (`common.name`). */
export const STATE_NAMES: Record<string, StateName> = {
    info: {
        en: 'Information',
        de: 'Information',
        ru: 'Информация',
        pt: 'Informação',
        nl: 'Informatie',
        fr: 'Informations',
        it: 'Informazioni',
        es: 'Información',
        pl: 'Informacje',
        uk: 'Інформація',
        'zh-cn': '信息',
    },
    connection: {
        en: 'Server is running',
        de: 'Server läuft',
        ru: 'Сервер запущен',
        pt: 'Servidor em execução',
        nl: 'Server draait',
        fr: 'Serveur en marche',
        it: 'Server in esecuzione',
        es: 'Servidor en ejecución',
        pl: 'Serwer działa',
        uk: 'Сервер працює',
        'zh-cn': '服务器运行中',
    },
    serverUuid: {
        en: 'HA-server UUID (stable across restarts)',
        de: 'HA-Server-UUID (bleibt über Neustarts hinweg)',
        ru: 'UUID HA-сервера (стабилен при перезапусках)',
        pt: 'UUID do servidor HA (estável entre reinícios)',
        nl: 'HA-server UUID (stabiel over herstarts)',
        fr: 'UUID du serveur HA (stable entre les redémarrages)',
        it: 'UUID del server HA (stabile tra i riavvii)',
        es: 'UUID del servidor HA (estable entre reinicios)',
        pl: 'UUID serwera HA (stabilny między restartami)',
        uk: 'UUID HA-сервера (стабільний між перезапусками)',
        'zh-cn': 'HA 服务器 UUID（重启后保持不变）',
    },
    refreshUrls: {
        en: 'Refresh URL discovery',
        de: 'URL-Erkennung neu laden',
        ru: 'Обновить URL-обнаружение',
        pt: 'Atualizar deteção de URLs',
        nl: 'URL-ontdekking vernieuwen',
        fr: 'Rafraîchir la découverte des URL',
        it: 'Aggiorna rilevamento URL',
        es: 'Refrescar detección de URLs',
        pl: 'Odśwież wykrywanie URL',
        uk: 'Оновити пошук URL',
        'zh-cn': '刷新 URL 发现',
    },
    clients: {
        en: 'Known display clients',
        de: 'Bekannte Display-Clients',
        ru: 'Известные display-клиенты',
        pt: 'Clientes de ecrã conhecidos',
        nl: 'Bekende display-clients',
        fr: 'Clients d’affichage connus',
        it: 'Client di display noti',
        es: 'Clientes de pantalla conocidos',
        pl: 'Znani klienci wyświetlaczy',
        uk: 'Відомі клієнти дисплеїв',
        'zh-cn': '已知显示客户端',
    },
    global: {
        en: 'Global redirect override',
        de: 'Globaler Weiterleitungs-Override',
        ru: 'Глобальное переопределение redirect',
        pt: 'Substituição global de redireccionamento',
        nl: 'Globale redirect-override',
        fr: 'Substitution globale de redirection',
        it: 'Override globale del redirect',
        es: 'Sobrescritura global de redirección',
        pl: 'Globalny redirect override',
        uk: 'Глобальне перевизначення redirect',
        'zh-cn': '全局重定向覆盖',
    },
    globalEnabled: {
        en: 'Apply global URL to all clients',
        de: 'Globale URL für alle Clients anwenden',
        ru: 'Применять глобальный URL для всех клиентов',
        pt: 'Aplicar URL global a todos os clientes',
        nl: 'Globale URL toepassen op alle clients',
        fr: 'Appliquer l’URL globale à tous les clients',
        it: 'Applica URL globale a tutti i client',
        es: 'Aplicar URL global a todos los clientes',
        pl: 'Stosuj globalny URL do wszystkich klientów',
        uk: 'Застосувати глобальний URL до всіх клієнтів',
        'zh-cn': '将全局 URL 应用到所有客户端',
    },
    globalMode: {
        en: 'Global redirect mode',
        de: 'Globaler Weiterleitungs-Modus',
        ru: 'Глобальный режим redirect',
        pt: 'Modo de redireccionamento global',
        nl: 'Globale redirect-modus',
        fr: 'Mode de redirection global',
        it: 'Modalità di redirect globale',
        es: 'Modo de redirección global',
        pl: 'Globalny tryb redirect',
        uk: 'Глобальний режим redirect',
        'zh-cn': '全局重定向模式',
    },
    globalManualUrl: {
        en: "Global manual URL (used when mode='manual')",
        de: "Globale manuelle URL (genutzt wenn mode='manual')",
        ru: "Глобальный ручной URL (используется при mode='manual')",
        pt: "URL manual global (usado quando mode='manual')",
        nl: "Globale handmatige URL (gebruikt als mode='manual')",
        fr: "URL manuelle globale (utilisée quand mode='manual')",
        it: "URL manuale globale (usato quando mode='manual')",
        es: "URL manual global (se usa cuando mode='manual')",
        pl: "Globalny ręczny URL (gdy mode='manual')",
        uk: "Глобальний ручний URL (коли mode='manual')",
        'zh-cn': "全局手动 URL（当 mode='manual' 时使用）",
    },
    clientMode: {
        en: 'Redirect mode',
        de: 'Weiterleitungs-Modus',
        ru: 'Режим redirect',
        pt: 'Modo de redireccionamento',
        nl: 'Redirect-modus',
        fr: 'Mode de redirection',
        it: 'Modalità redirect',
        es: 'Modo de redirección',
        pl: 'Tryb redirect',
        uk: 'Режим redirect',
        'zh-cn': '重定向模式',
    },
    clientManualUrl: {
        en: 'Manual URL',
        de: 'Manuelle URL',
        ru: 'Ручной URL',
        pt: 'URL manual',
        nl: 'Handmatige URL',
        fr: 'URL manuelle',
        it: 'URL manuale',
        es: 'URL manual',
        pl: 'Ręczny URL',
        uk: 'Ручний URL',
        'zh-cn': '手动 URL',
    },
    clientIp: {
        en: 'Client IP',
        de: 'Client-IP',
        ru: 'IP клиента',
        pt: 'IP do cliente',
        nl: 'Client-IP',
        fr: 'IP du client',
        it: 'IP del client',
        es: 'IP del cliente',
        pl: 'IP klienta',
        uk: 'IP клієнта',
        'zh-cn': '客户端 IP',
    },
    clientRemove: {
        en: 'Forget this client',
        de: 'Diesen Client entfernen',
        ru: 'Удалить этого клиента',
        pt: 'Esquecer este cliente',
        nl: 'Deze client vergeten',
        fr: 'Oublier ce client',
        it: 'Dimentica questo client',
        es: 'Olvidar este cliente',
        pl: 'Zapomnij tego klienta',
        uk: 'Забути цього клієнта',
        'zh-cn': '移除此客户端',
    },
};

/** State descriptions (`common.desc`). */
export const STATE_DESCS: Record<string, StateName> = {
    serverUuidDesc: {
        en: "Persistent UUID broadcast via mDNS and /api/discovery_info. Generated once on first start and re-used across restarts so HA-Clients don't treat each restart as a new server (which would invalidate cached identity, force re-onboarding and drop tokens).",
        de: 'Persistente UUID, broadcastet via mDNS und /api/discovery_info. Wird beim ersten Start einmal erzeugt und über Neustarts hinweg wiederverwendet, sodass HA-Clients nicht jeden Neustart als neuen Server behandeln (was die gecachte Identität ungültig machen, Re-Onboarding erzwingen und Tokens verwerfen würde).',
        ru: 'Постоянный UUID, транслируемый через mDNS и /api/discovery_info. Генерируется один раз при первом старте и переиспользуется при перезапусках, чтобы HA-клиенты не считали каждый рестарт новым сервером.',
        pt: 'UUID persistente difundido via mDNS e /api/discovery_info. Gerado uma vez no primeiro arranque e reutilizado entre reinícios para que os clientes HA não tratem cada reinício como um novo servidor.',
        nl: 'Persistente UUID die via mDNS en /api/discovery_info wordt uitgezonden. Wordt eenmaal gegenereerd bij de eerste start en blijft over herstarts behouden zodat HA-clients elke herstart niet als nieuwe server zien.',
        fr: 'UUID persistant diffusé via mDNS et /api/discovery_info. Généré une fois au premier démarrage et réutilisé entre redémarrages, ainsi les clients HA ne traitent pas chaque redémarrage comme un nouveau serveur.',
        it: 'UUID persistente trasmesso via mDNS e /api/discovery_info. Generato una volta al primo avvio e riutilizzato tra i riavvii: così i client HA non considerano ogni riavvio come un nuovo server.',
        es: 'UUID persistente difundido vía mDNS y /api/discovery_info. Se genera una vez en el primer arranque y se reutiliza entre reinicios para que los clientes HA no traten cada reinicio como un servidor nuevo.',
        pl: 'Trwały UUID rozgłaszany przez mDNS i /api/discovery_info. Generowany raz przy pierwszym starcie i ponownie używany przy restartach, aby klienci HA nie traktowali każdego restartu jako nowego serwera.',
        uk: 'Постійний UUID, що транслюється через mDNS та /api/discovery_info. Створюється один раз при першому запуску й повторно використовується після перезапусків, щоб HA-клієнти не сприймали кожен перезапуск як новий сервер.',
        'zh-cn':
            '通过 mDNS 和 /api/discovery_info 广播的持久 UUID。首次启动时生成一次，重启之间复用，避免 HA 客户端每次重启都视为新服务器。',
    },
    refreshUrlsDesc: {
        en: 'Write true to re-scan the broker for VIS/VIS-2 projects, Admin tiles and other discovered URLs. Useful after creating a new VIS view without restarting the adapter.',
        de: 'Auf true setzen, um den Broker nach VIS/VIS-2-Projekten, Admin-Kacheln und weiteren URLs neu zu durchsuchen. Sinnvoll nach Anlegen einer neuen VIS-View ohne Adapter-Neustart.',
        ru: 'Запишите true, чтобы пересканировать брокер на VIS/VIS-2-проекты, Admin-плитки и другие URL. Удобно после создания новой VIS-view без перезапуска адаптера.',
        pt: 'Escreve true para voltar a procurar projetos VIS/VIS-2, mosaicos Admin e outros URLs no broker. Útil após criar uma nova view VIS sem reiniciar o adaptador.',
        nl: 'Schrijf true om de broker opnieuw te scannen op VIS/VIS-2-projecten, admin-tegels en andere URLs. Handig na het aanmaken van een nieuwe VIS-view zonder de adapter te herstarten.',
        fr: 'Écrivez true pour ré-analyser le broker à la recherche de projets VIS/VIS-2, de tuiles Admin et d’autres URL. Utile après la création d’une nouvelle vue VIS sans redémarrer l’adaptateur.',
        it: 'Scrivi true per ri-scansionare il broker per progetti VIS/VIS-2, tile Admin e altri URL. Utile dopo aver creato una nuova view VIS senza riavviare l’adattatore.',
        es: 'Escribe true para volver a escanear el broker en busca de proyectos VIS/VIS-2, mosaicos Admin y otras URLs. Útil tras crear una nueva vista VIS sin reiniciar el adaptador.',
        pl: 'Wpisz true, aby ponownie przeszukać broker pod kątem projektów VIS/VIS-2, kafelków Admin i innych URL. Przydatne po utworzeniu nowego widoku VIS bez restartu adaptera.',
        uk: 'Запишіть true, щоб повторно сканувати брокер на проекти VIS/VIS-2, admin-плитки та інші URL. Корисно після створення нової VIS-view без перезапуску адаптера.',
        'zh-cn':
            '写入 true 以重新扫描 broker 上的 VIS/VIS-2 项目、Admin 瓷贴和其他 URL。在不重启适配器的情况下创建新 VIS 视图后很有用。',
    },
};

/** Dropdown values (`common.states` map). */
export const STATE_LABELS: Record<string, StateName> = {
    noChoice: {
        en: '---',
        de: '---',
        ru: '---',
        pt: '---',
        nl: '---',
        fr: '---',
        it: '---',
        es: '---',
        pl: '---',
        uk: '---',
        'zh-cn': '---',
    },
    globalUrl: {
        en: 'Global URL',
        de: 'Globale URL',
        ru: 'Глобальный URL',
        pt: 'URL global',
        nl: 'Globale URL',
        fr: 'URL globale',
        it: 'URL globale',
        es: 'URL global',
        pl: 'Globalny URL',
        uk: 'Глобальний URL',
        'zh-cn': '全局 URL',
    },
    manualUrl: {
        en: 'Manual URL',
        de: 'Manuelle URL',
        ru: 'Ручной URL',
        pt: 'URL manual',
        nl: 'Handmatige URL',
        fr: 'URL manuelle',
        it: 'URL manuale',
        es: 'URL manual',
        pl: 'Ręczny URL',
        uk: 'Ручний URL',
        'zh-cn': '手动 URL',
    },
};

/**
 * Translation object for a state name. Pass into `common.name`; ioBroker
 * Admin/vis/Object-Browser localizes automatically.
 *
 * @param key Translation key in {@link STATE_NAMES}.
 */
export function tName(key: keyof typeof STATE_NAMES): StateName {
    return STATE_NAMES[key];
}

/**
 * Translation object for `common.desc`. Same lookup mechanism as `tName`.
 *
 * @param key Translation key in {@link STATE_DESCS}.
 */
export function tDesc(key: keyof typeof STATE_DESCS): StateName {
    return STATE_DESCS[key];
}

/**
 * Plain-string label for a `common.states` map. Resolves the translation
 * for the given language with EN-fallback. Pass `adapter.systemLanguage`
 * which is sourced once from `system.config.language` at adapter start.
 *
 * **This is the ONLY supported path for `common.states` VALUES.** A
 * translation-object value (the shape returned by {@link STATE_LABELS}
 * entries directly) crashes the Admin GUI with React Error #31 — admin
 * renders states-values as React children. v1.28.4 deleted a `tLabel`
 * helper that returned the raw object and was easy to misuse. See
 * memory `reference_common_states_plain_string_only` for the full story.
 *
 * @param key Translation key in {@link STATE_LABELS}.
 * @param lang Target language code (typically `adapter.systemLanguage`). Falls back to `en`.
 */
export function resolveLabel(key: keyof typeof STATE_LABELS, lang: string): string {
    const obj = STATE_LABELS[key];
    if (typeof obj === 'string') {
        return obj;
    }
    const dict = obj as unknown as Record<string, string>;
    return dict[lang] ?? dict.en ?? key;
}
